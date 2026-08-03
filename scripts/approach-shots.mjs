#!/usr/bin/env node
// THE APPROACH SHEET — the only test that can fail a geometry LOD.
//
// Counts say a change is cheaper. They cannot say it is invisible and they
// cannot say it does not POP: a thinning rule that removes half a shoreline in
// one step is a triangle win and a visual regression, and the count column reads
// identically either way. perf-census and test-perf-budget both grade totals;
// nothing in this repo could look at the picture the totals came from.
//
// So: ONE island, one bearing, six ranges closing on it, plus a wide vista and
// the same vista turned away — and beside every frame, the tracked island's
// per-batch instance counts. The counts follow one island the whole way down
// because the NEAREST island changes identity mid-approach and the numbers jump
// for that reason alone. A batch that steps rather than ramps is named in the
// column beside the frame where it stepped.
//
// WHAT IT DOES NOT CONTROL: the weather. The storm arrives on the match clock
// and a ladder takes minutes, so late frames can be a night squall while early
// ones are noon. That is fine for reading POPULATION and SILHOUETTE, which is
// what this sheet is for, and useless for reading colour. Pin nothing on the
// lighting here.
//
//   PIRATES_BR_SERVER_PORT=8091 node scripts/approach-shots.mjs http://127.0.0.1:3101 after high
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2];
const TAG = process.argv[3];
const QUALITY = process.argv[4] ?? 'high';
const PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
// Under the repo, like every other shot rig here. This was a hard-coded path
// into one session's scratch directory, which exists on nobody else's machine
// and made the sheet unfindable the moment that session ended.
const OUT = process.argv[5] ?? `test-results/approach-${TAG ?? 'shots'}-${QUALITY}`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
try {
  page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
  await page.goto(`${URL}/?debug&quality=${QUALITY}&server=${PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
  await page.waitForTimeout(14_000);
  await page.evaluate(() => window.__piratesBR.setBotPeace(true));
  await page.evaluate(() => {
    const e = document.createElement('style');
    e.textContent = '#onboarding-card,#oc-card,[class*="onboard"]{display:none!important;}'
      + '#hud{visibility:hidden!important;}'
      + '#disconnect-overlay,.server-overloaded,#server-overloaded,[class*="overload"]{visibility:hidden!important;}';
    document.head.appendChild(e);
    document.getElementById('oc-skip')?.click();
  });

  const isl = await page.evaluate(() => {
    const g = window.__piratesBR;
    const out = {};
    for (const i of g.state.islands) out[i.name] = { x: i.position.x, z: i.position.z, r: i.radius };
    return out;
  });

  // ONE shoreline, closing. Ranges are from the island EDGE, which is the same
  // distance every gate in the client measures against, so each step lands in a
  // named band: 900 past the portal-rock density knot, 600 and 380 inside it,
  // 220 and 120 in the pebble ramp, 40 at its top where nothing is thinned.
  const target = isl['Castaway Reach'] ?? Object.values(isl)[0];
  const shots = [];
  for (const d of [900, 600, 380, 220, 120, 40]) {
    shots.push({
      name: `approach-${String(d).padStart(3, '0')}`,
      x: target.x - (target.r + d) * 0.7071,
      y: Math.min(30, 6 + d * 0.03),
      z: target.z - (target.r + d) * 0.7071,
      aim: target,
      pitch: -0.08,
      track: 'Castaway Reach',
    });
  }
  // …and a wide vista of a DIFFERENT island, which is where the group cull and
  // the portal-rock thinning are both live at once.
  const wide = isl['Skull Cove'] ?? Object.values(isl)[1] ?? target;
  shots.push({ name: 'vista-780', x: wide.x - (wide.r + 780), y: 40, z: wide.z - (wide.r + 780), aim: wide, pitch: -0.06, track: 'Skull Cove' });
  // …and the same vista with the camera turned 180°, so the group cull is
  // certainly firing on the islands behind it.
  shots.push({ name: 'vista-away', x: wide.x - (wide.r + 780), y: 40, z: wide.z - (wide.r + 780), aim: { x: wide.x - (wide.r + 3000), z: wide.z - (wide.r + 3000) }, pitch: -0.06, track: 'Skull Cove' });

  for (const s of shots) {
    await page.evaluate((c) => {
      const g = window.__piratesBR;
      const yaw = Math.atan2(c.aim.x - c.x, c.aim.z - c.z);
      g.enableFreeCam(c.x, c.y, c.z, yaw, c.pitch);
      g.setDayNightOverride(854); // pinned noon: a moving sun is not a comparison
      g.settleLod?.();
    }, s);
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__piratesBR.settleLod?.());
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${s.name}-${QUALITY}-${TAG}.png`, timeout: 180_000 });
    const state = await page.evaluate((trackName) => {
      const g = window.__piratesBR;
      const info = g.renderer.renderer.info;
      const batches = [];
      let culled = 0; let groups = 0;
      for (const [, group] of g.islandMeshes) {
        groups += 1;
        if (!group.visible) culled += 1;
      }
      // The batch column has to follow ONE island the whole way down the ladder
      // or it is six unrelated readings: the nearest island changes identity
      // mid-approach and the counts jump for that reason alone.
      const tracked = g.state.islands.find((i) => i.name === trackName) ?? g.state.islands[0];
      const nearest = { i: tracked, d: Math.hypot(tracked.position.x - g.renderer.camera.position.x, tracked.position.z - g.renderer.camera.position.z) - tracked.radius };
      const group = g.islandMeshes.get(nearest.i.id);
      for (const b of group?.userData.instanceLodBatches ?? []) {
        batches.push(`${b.mesh.name.replace(/^(props-|island-)/, '')}=${b.mesh.count}/${b.full}${b.mesh.visible ? '' : ' HID'}`);
      }
      return {
        draws: info.render.calls,
        tris: info.render.triangles,
        culled,
        groups,
        near: `${nearest.i.name}@${Math.round(nearest.d)}m`,
        batches: batches.sort(),
        visible: group ? group.visible : null,
      };
    }, s.track);
    console.log(
      `${s.name}-${QUALITY}-${TAG}  draws=${state.draws} tris=${Math.round(state.tris / 1000)}k `
      + `groupsCulled=${state.culled}/${state.groups}  tracked=${state.near} groupVisible=${state.visible}`,
    );
    console.log(`    ${state.batches.join('  ')}`);
  }
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
