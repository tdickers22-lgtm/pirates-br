#!/usr/bin/env node
/**
 * THE TELLS A NEW PIRATE IS SUPPOSED TO SEE.
 *
 * The fresh-eyes audit walked eight legs off its spawn island and fired ZERO
 * loot prompts: the barrels were inland behind the dock's blind quarter, the
 * one chest in reach was already dug and still pulled a walk, and the buried
 * ones were a pebble of a mound on pale sand. Three fixes answered that — the
 * landing stores at the pier head (MapGenerator), the turning, twinkling dig
 * tell (Game/EntityMeshes), and an objective line that finally names digging
 * (HudController). This looks at all three FROM THE DOCK, where the complaint
 * was made, because each of them is invisible in a passing unit test: a beach
 * with no barrels and a beach whose barrels are 90 m inland read identically
 * from a state dump that only counts them.
 *
 *   PIRATES_GL=swiftshader node scripts/loot-tells-probe.mjs [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { browserArgs, describeGl, IS_SOFTWARE_GL } from './lib/browser-args.mjs';

const OUT = process.argv[2] ?? 'test-results/loot-tells';
mkdirSync(OUT, { recursive: true });
console.log(`GL backend: ${describeGl()}`);
const browser = await chromium.launch({ args: browserArgs() });
const page = await browser.newPage({
  viewport: IS_SOFTWARE_GL ? { width: 960, height: 540 } : { width: 1280, height: 720 },
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// Every exit path closes the browser: an orphaned headless Chromium has frozen
// this machine's desktop twice, so it is not a tidiness concern.
const closeBrowser = () => browser.close().catch(() => {});
process.on('exit', () => { closeBrowser(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { closeBrowser().finally(() => process.exit(130)); });
}
for (const fault of ['uncaughtException', 'unhandledRejection']) {
  process.on(fault, (err) => {
    console.error(`\n${fault}: ${err?.stack ?? err}`);
    closeBrowser().finally(() => process.exit(1));
  });
}

const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));

await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });

// Wait out the opening ceremony by the hooks that exist, then spend frames — on
// the software rasteriser a millisecond budget buys no frames at all.
const ready = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const start = performance.now();
  let after = 0;
  while (performance.now() - start < 90_000) {
    await frame();
    const g = window.__piratesBR;
    const ceremony = typeof g?.isStartCeremonyActive === 'function'
      ? g.isStartCeremonyActive()
      : document.body.classList.contains('match-ceremony');
    if (g?.state?.phase === 'playing' && ceremony === false) { after += 1; if (after > 8) return true; }
  }
  return false;
});
ok('the match is up and the ceremony is over', ready === true);

// Dismiss the tour if this profile has never played — the cards would sit over
// the beach this probe exists to photograph.
await page.evaluate(() => document.getElementById('oc-skip')?.click());

const survey = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.getLocalPlayer?.() ?? g.state.players.find((p) => p.id === g.localPlayerId);
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  // The island you are standing on, by its own dock.
  const island = [...g.state.islands].sort((a, b) => d(a.position, me.position) - d(b.position, me.position))[0];
  const dock = island?.dock ?? null;
  const from = dock ? dock.position : me.position;
  const barrels = (island?.barrels ?? [])
    .map((b) => ({ id: b.id, opened: !!b.opened, dist: +d(b.position, from).toFixed(1), pos: b.position }))
    .sort((a, b) => a.dist - b.dist);
  const chests = (island?.chests ?? [])
    .map((c) => ({
      id: c.id, buried: !!c.buried, dug: (c.digProgress ?? 0) >= 1, opened: !!c.opened,
      dist: +d(c.position, from).toFixed(1), pos: c.position,
    }))
    .sort((a, b) => a.dist - b.dist);
  // The client's own dig tells: a mound that is showing, and the sparkle on it.
  const tells = [];
  for (const [id, rec] of g.chestMeshes ?? []) {
    if (!rec?.mound) continue;
    const sparkle = rec.mound.userData?.digSparkle ?? null;
    // `mound.position` is LOCAL to the chest group — reading it as a world point
    // put every tell at the same impossible 608 m. The world translation is the
    // last column of matrixWorld, which is the only honest number here.
    rec.mound.updateWorldMatrix(true, false);
    const m = rec.mound.matrixWorld.elements;
    tells.push({
      id,
      moundVisible: rec.mound.visible === true,
      moundScale: +rec.mound.scale.x.toFixed(2),
      hasSparkle: !!sparkle,
      sparkleOpacity: sparkle ? +(sparkle.material?.opacity ?? 0).toFixed(2) : null,
      dist: +d({ x: m[12], z: m[14] }, from).toFixed(1),
    });
  }
  tells.sort((a, b) => a.dist - b.dist);
  return {
    island: island?.name ?? null,
    playerPos: me?.position ?? null,
    dockPos: dock?.position ?? null,
    shoreAngle: dock?.shoreAngle ?? null,
    barrels: barrels.slice(0, 8),
    chests: chests.slice(0, 6),
    tells: tells.filter((t) => t.moundVisible).slice(0, 6),
    objective: document.getElementById('objective-line')?.textContent
      ?? document.getElementById('br-objective')?.textContent
      ?? [...document.querySelectorAll('div')].map((e) => e.textContent ?? '')
        .find((t) => /^Objective:/.test(t.trim())) ?? '',
    gold: me?.gold ?? null,
  };
});
console.log(`  · ${survey.island}: ${JSON.stringify(survey.barrels.slice(0, 5))}`);
console.log(`  · dig tells showing: ${JSON.stringify(survey.tells.slice(0, 4))}`);
console.log(`  · objective: "${survey.objective.trim()}"`);

const nearBarrels = survey.barrels.filter((b) => b.dist <= 46 && !b.opened);
ok('the spawn pier has landing stores within sight of it',
  nearBarrels.length >= 2, `${nearBarrels.length} unopened barrels ≤46 m (nearest ${nearBarrels[0]?.dist ?? '—'} m)`);
ok('at least one dig tell is SHOWING on this island, and it twinkles',
  survey.tells.length >= 1 && survey.tells.some((t) => t.hasSparkle),
  JSON.stringify(survey.tells[0] ?? null));
ok('an already-dug site advertises nothing',
  survey.tells.every((t) => t.moundScale > 0.06),
  JSON.stringify(survey.tells.map((t) => t.moundScale)));
// THE OBJECTIVE LADDER, READ AT THE RIGHT RUNG.
// At the pier the line is "board your ship", and that is correct — the dig line
// is the FIRST POST-BOARDING objective, and asserting it here would fail a HUD
// that is right. The first cut of this check did exactly that. Rather than sail
// (six-second frames make a 20 m walk a five-minute probe), retire the boarding
// objective the way boarding retires it and read the next rung down.
ok('at the pier the objective is still the pier\'s objective',
  /board your ship/i.test(survey.objective), `"${survey.objective.trim()}"`);
const afterBoard = await page.evaluate(async () => {
  const g = window.__piratesBR;
  g.ownShipObjectiveDone = true;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 10; i += 1) await frame();
  return [...document.querySelectorAll('div')].map((e) => e.textContent ?? '')
    .find((t) => /^Objective:/.test(t.trim())) ?? '';
});
console.log(`  · objective once the deck is yours: "${afterBoard.trim()}"`);
ok('the next objective names the verb the economy starts with, and the tell to look for',
  /dig/i.test(afterBoard) && /sparkl/i.test(afterBoard), `"${afterBoard.trim()}"`);

// ── PIXELS ─────────────────────────────────────────────────────────────────
// Look at the nearest store from where a crew stands, then at the nearest tell.
async function lookAt(target, name) {
  await page.evaluate(({ target }) => {
    const g = window.__piratesBR;
    const me = g.getLocalPlayer?.() ?? g.state.players.find((p) => p.id === g.localPlayerId);
    const yaw = Math.atan2(target.x - me.position.x, target.z - me.position.z);
    g.input.setLook(yaw, -0.12);
  }, { target });
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 12; i += 1) await frame();
  });
  await shot(name);
}
if (nearBarrels[0]) await lookAt(nearBarrels[0].pos, `1-landing-stores-${Math.round(nearBarrels[0].dist)}m`);
const tellChest = survey.chests.find((c) => c.buried && !c.dug);
if (tellChest) await lookAt(tellChest.pos, `2-dig-tell-${Math.round(tellChest.dist)}m`);

console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 3).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
process.exit(failed.length ? 1 : 0);
