// Storm-wall visual probe: the boundary of the shrinking ring, seen from inside,
// at the wall, and from outside, at noon / dusk / night. This is the frame the
// "hard-edged black void covering half the sky" defect lives in.
//   node --import tsx scripts/storm-wall-probe.mjs <outDir> [noon dusk night]
// Requires the dev stack (vite :3000 + ws :8090). GPU-headless.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/storm-wall';
const WANT = process.argv.slice(3);
const want = (name) => WANT.length === 0 || WANT.includes(name);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

async function session(query, attempts = 4) {
  for (let n = 1; n <= attempts; n++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    try {
      await page.goto(`http://127.0.0.1:3000/${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#menu-solo-btn', { timeout: 25_000 });
      await page.click('#menu-solo-btn', { noWaitAfter: true });
      await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 45_000 });
      await page.waitForTimeout(3000);
      return page;
    } catch (err) {
      console.log(`  join attempt ${n} failed: ${err.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      if (n === attempts) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw new Error('unreachable');
}

// A socket drop mid-tour throws an 82%-black overlay over the whole viewport,
// which would make every later pixel read useless. The renderer keeps drawing
// the last snapshot, so the shot itself stays valid — just drop the overlay.
const clean = (page) => page.evaluate(() => document.getElementById('disconnect-overlay')?.remove());
const shot = async (page, name) => {
  await clean(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60_000 });
};
const wait = (page, ms) => page.waitForTimeout(ms);
const look = (page, [x, y, z], yaw, pitch) => page.evaluate(
  ([p, ya, pi]) => window.__piratesBR.enableFreeCam(p[0], p[1], p[2], ya, pi),
  [[x, y, z], yaw, pitch],
);
const time = (page, sec) => page.evaluate((s) => window.__piratesBR.setDayNightOverride(s), sec);

// Two sessions matter here and they show different halves of the defect:
//  clear — a normal match. The local player is INSIDE the ring, so the sky is
//          fair and the wall cylinder stands against it: this is the frame the
//          "black void with a razor edge" was reported in.
//  demo  — ?stormdemo pins full weather everywhere, so it shows the wall while
//          the rain/lightning machinery is actually running.
const MODE = process.env.WALL_MODE ?? 'clear';
const page = await session(MODE === 'demo' ? '?debug&quality=high&stormdemo' : '?debug&quality=high');
const s = await page.evaluate(() => {
  const st = window.__piratesBR.state.storm;
  return { cx: st.centerX, cz: st.centerZ, r: st.safeRadius, phase: st.phase };
});
console.log('storm', MODE, JSON.stringify(s));
let { cx, cz, r } = s;

// 'pin' — hold the ring at a late-phase radius the local player is still just
// inside, so the wall can be seen from a few metres away with FAIR weather
// behind it. The snapshot rewrites state.storm every tick, so the pin has to
// be re-applied every frame from a rAF loop.
if (MODE === 'pin') {
  const pinR = Number(process.env.WALL_PIN_R ?? 700);
  await page.evaluate((pr) => {
    const g = window.__piratesBR;
    const loop = () => {
      const st = g.state?.storm;
      if (st) { st.safeRadius = pr; st.nextRadius = pr * 0.7; st.phase = 4; }
      requestAnimationFrame(loop);
    };
    loop();
  }, pinR);
  await wait(page, 800);
  r = await page.evaluate(() => window.__piratesBR.state.storm.safeRadius);
  console.log('pinned radius', r);
}

// All cams sit on the +X radius and look along -X (toward the centre) or +X
// (out to sea), so "the wall" is dead ahead and the ring's tangent runs across
// the frame — which is where the razor diagonal used to cut the sky.
const IN = Math.PI * 1.5;  // -X, toward the storm centre
const OUT_ = Math.PI * 0.5; // +X, away from it
const views = MODE === 'pin'
  ? [
    ['01-inside-30m-out', 0.957, 7, OUT_, 0.06],
    ['02-inside-30m-up', 0.957, 7, OUT_, 0.55],
    ['03-inside-120m-out', 0.83, 7, OUT_, 0.16],
    ['04-inside-300m-out', 0.57, 9, OUT_, 0.12],
    ['05-inside-tangent', 0.93, 8, OUT_ + 0.9, 0.20],
    ['06-aerial', 1.15, 150, IN, -0.30],
  ]
  : [
    ['01-inside-mid-out', 0.45, 7, OUT_, 0.06],
    ['02-inside-near-out', 0.9, 7, OUT_, 0.06],
    ['03-inside-near-up', 0.9, 7, OUT_, 0.42],
    ['04-at-wall-out', 1.0, 7, OUT_, 0.10],
    ['05-outside-back-in', 1.12, 7, IN, 0.06],
    ['06-outside-far-in', 1.35, 12, IN, 0.10],
    ['07-outside-far-up', 1.35, 12, IN, 0.45],
    ['08-aerial', 1.6, 190, IN, -0.28],
  ];

for (const [tag, sec] of [['noon', 854], ['dusk', 240], ['night', 374]]) {
  if (!want(tag)) continue;
  await time(page, sec);
  await wait(page, 900);
  for (const [name, mult, y, yaw, pitch] of views) {
    await look(page, [cx + r * mult, y, cz], yaw, pitch);
    await wait(page, 850);
    await shot(page, `${tag}-${name}`);
  }
  console.log(`${tag} done`);
}

console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__piratesBR;
  return {
    weather: g.stormWeatherIntensity ?? null,
    rain: g.stormRainIntensity ?? null,
    wallOpacity: g.stormWall?.material?.opacity ?? null,
    wallScale: g.stormWall?.scale?.x ?? null,
  };
})));

await page.close();
await browser.close();
console.log(`shots in ${OUT}/`);
