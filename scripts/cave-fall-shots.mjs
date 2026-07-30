// Cave-portal + waterfall visual shot sheet (fix wave 2/3, defects P1 + P2).
//
// One join, then a fixed set of free-cam framings on ONE named island, at noon
// and at night, so a before/after pair is comparable pixel for pixel:
//   mouth-30 / mouth-05      the rock portal read from approach and at the lip
//   interior-out             standing inside, looking back at daylight
//   interior-deep            the dressed interior (crystals, scatter, warm light)
//   fall-full / fall-base    the tallest fall head-on, and its plunge pool
//
// node scripts/cave-fall-shots.mjs <outDir> "<island name>" [tag]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/cave-fall';
const WANT = process.argv[3] ?? 'Old Maw';
const TAG = process.argv[4] ?? '';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
const name = (n) => `${OUT}/${TAG ? `${TAG}-` : ''}${n}.png`;
const shot = (n) => page.screenshot({ path: name(n), timeout: 90_000 });

// Other agents' edits make vite full-reload this tab mid-run; stub the HMR client.
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

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
// 3rd arg = options. (2nd is the page-fn ARG — the classic silent-30s trap.)
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
await wait(3500);
await page.evaluate(() => {
  const e = document.createElement('style');
  // Another agent's server edits restart :8090 mid-run; the disconnect overlay
  // would then paint over every remaining frame. The last snapshot keeps
  // rendering, which is exactly the static world these shots are OF.
  // The onboarding card and the overload badge are the other two things that
  // paint over a shot sheet — the card also DIMS the whole scene, which is why
  // an early version of this run photographed the mouth at half brightness.
  e.textContent = '#hud,#disconnect-overlay{visibility:hidden!important;}'
    + '#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}'
    + '.server-overloaded,#server-overloaded,[class*="overload"]{display:none!important;}';
  document.head.appendChild(e);
  document.getElementById('oc-skip')?.click();
});
// Every island's mesh must EXIST before we fly to one: the build queue is
// drip-fed per frame, and a free cam parked at a cave that has not been built
// yet photographs open water.
await page.evaluate(() => window.__piratesBR.drainIslandBuildQueue?.(40));
await page.waitForFunction(
  () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99),
  null, { timeout: 90_000 },
).catch(() => {});
await wait(1200);

async function look(pos, target) {
  await page.evaluate(([p, t]) => {
    const g = window.__piratesBR;
    const dx = t[0] - p[0]; const dy = t[1] - p[1]; const dz = t[2] - p[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    g.enableFreeCam(p[0], p[1], p[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
  }, [pos, target]);
  await wait(500);
}

const info = await page.evaluate((want) => {
  const g = window.__piratesBR;
  const isl = (g.state.islands ?? []).find((i) => (i.name ?? '').toLowerCase().includes(want.toLowerCase()));
  if (!isl) return null;
  const mouth = (isl.caves ?? []).find((c) => c.hasMouth) ?? null;
  const falls = [];
  const mesh = g.islandMeshes?.get(isl.id);
  mesh?.traverse((o) => {
    if (o.name === 'waterfall-site') {
      falls.push({
        lip: o.userData.lip, base: o.userData.base, dir: o.userData.dir,
        drop: o.userData.drop, steps: o.userData.steps, faceChutes: o.userData.faceChutes,
      });
    }
  });
  falls.sort((a, b) => b.drop - a.drop);
  let portals = 0; let boulders = 0;
  mesh?.traverse((o) => {
    if (o.name === 'cave-portal-rock') { portals++; boulders += o.count ?? 1; }
  });
  return {
    name: isl.name, id: isl.id, ix: isl.position.x, iz: isl.position.z, ir: isl.radius,
    caves: (isl.caves ?? []).length,
    mouth: mouth && {
      x: mouth.position.x, y: mouth.position.y, z: mouth.position.z, rot: mouth.rotation,
      floorY: mouth.floorY, floorYEnd: mouth.floorYEnd ?? mouth.floorY,
      width: mouth.width, height: mouth.height,
      length: mouth.length ?? 10, interiorRadius: mouth.interiorRadius ?? 3,
    },
    falls, portals, boulders,
    decorRejects: mesh?.userData?.caveDecorRejects ?? null,
  };
}, WANT);
console.log(JSON.stringify(info, null, 1));
if (!info) { await browser.close(); throw new Error(`island "${WANT}" not found`); }

const m = info.mouth;
const ox = Math.sin(m.rot); const oz = Math.cos(m.rot);   // outward from the mouth
const fall = info.falls[0] ?? null;

async function sheet(suffix) {
  // ── cave portal ──
  await look([m.x + ox * 30, m.floorY + 9, m.z + oz * 30], [m.x, m.floorY + 2.6, m.z]);
  await shot(`mouth-30${suffix}`);
  await look([m.x + ox * 5.5, m.floorY + 1.7, m.z + oz * 5.5], [m.x, m.floorY + 2.2, m.z]);
  await shot(`mouth-05${suffix}`);
  // ── interior ──
  // Cave-local (lx, lz) → world, same basis the builder uses.
  const cs = Math.cos(m.rot); const sn = Math.sin(m.rot);
  const at = (lx, lz) => [m.x + lx * cs + lz * sn, m.z - lx * sn + lz * cs];
  // The tunnel FLOOR ramps down into the hill (floorY → floorYEnd); a fixed eye
  // height off the mouth floor puts the camera in the ceiling rock deeper in.
  const eyeAt = (lz) => m.floorY
    + (m.floorYEnd - m.floorY) * Math.min(1, Math.max(0, -lz / m.length)) + 1.65;
  const outDepth = -m.length * 0.5;
  const [ax1, az1] = at(0, outDepth);
  const [ox1, oz1] = at(0, 8);
  await look([ax1, eyeAt(outDepth), az1], [ox1, eyeAt(0) + 0.4, oz1]);
  await shot(`interior-out${suffix}`);
  for (const d of [3, 8, 13]) {
    const lz = -Math.min(d, m.length - 1.5);
    const tz0 = -Math.min(d + 5, m.length - 0.5);
    const [cx, cz] = at(0, lz);
    const [tx, tz] = at(m.interiorRadius * 0.7, tz0);
    await look([cx, eyeAt(lz), cz], [tx, eyeAt(tz0) - 0.2, tz]);
    await shot(`interior-${d}m${suffix}`);
  }
  // ── waterfall ──
  if (fall) {
    const fx = fall.dir.x; const fz = fall.dir.z;
    const midY = (fall.lip.y + fall.base.y) * 0.5;
    const midX = (fall.lip.x + fall.base.x) * 0.5;
    const midZ = (fall.lip.z + fall.base.z) * 0.5;
    const back = Math.max(26, fall.drop * 2.0);
    await look([midX + fx * back, midY + fall.drop * 0.15, midZ + fz * back], [midX, midY, midZ]);
    await shot(`fall-full${suffix}`);
    await look(
      [fall.base.x + fx * 12 - fz * 6, fall.base.y + 5.0, fall.base.z + fz * 12 + fx * 6],
      [fall.base.x, fall.base.y + 0.6, fall.base.z],
    );
    await shot(`fall-base${suffix}`);
    // mid-fall, the exact framing the audit flagged the ribbon jog in
    await look(
      [midX + fx * 18 - fz * 9, midY + 3.0, midZ + fz * 18 + fx * 9],
      [midX, midY, midZ],
    );
    await shot(`fall-mid${suffix}`);
  }
}

await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(700);
await sheet('');
await page.evaluate(() => window.__piratesBR.setDayNightOverride(374));
await wait(900);
await sheet('-night');

await page.evaluate(() => window.__piratesBR.disableFreeCam());
await browser.close();
if (errors.length) console.log('CONSOLE ERRORS:', errors.slice(0, 8));
console.log(`shots → ${OUT}`);
