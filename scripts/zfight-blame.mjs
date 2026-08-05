#!/usr/bin/env node
// NAME THE TWO SURFACES IN A DEPTH FIGHT, by taking each of them away in turn.
//
// The gate (scripts/test-z-fighting.mjs) says a stand has N coplanar-patch tie
// pixels. This says WHICH materials own them, which is the only thing a fix
// needs and the one thing a count cannot tell you.
//
//   PIRATES_GL=swiftshader PIRATES_BR_SERVER_PORT=8093 PIRATES_BR_URL=http://127.0.0.1:3103 \
//     node scripts/zfight-blame.mjs --scene deck-aft --tod noon --dolly 0.17
//
// It never starts or stops a game server. Sweeps run in chunks so the log moves;
// every render WITHIN a chunk happens in one synchronous task, so the hull cannot
// sail between a baseline and the ablations it is compared against.
import { chromium } from 'playwright';
import process from 'node:process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { readWorld, sessionQuery, SERVER_PORT } from './perf-probe.mjs';
import { ensureDevClient, stopDevClient } from './lib/dev-client.mjs';
import { PIN_PROBE_RESOLUTION, PLACE_AND_SETTLE } from './lib/zfight-probe.mjs';
import { LIST_MATERIALS, BLAME_SWEEP, PIERCE_LOCAL } from './lib/zfight-blame.mjs';
import { planStands, TIME_OF_DAY, VIEWPORT } from './lib/zfight-stands.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = (process.env.PIRATES_BR_URL ?? arg('url', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const QUALITY = arg('quality', 'low');
const SCENE = arg('scene', 'deck-aft');
const TOD = arg('tod', 'noon');
const DOLLY_M = parseFloat(arg('dolly', '0.17'));
const CHUNK = parseInt(arg('chunk', '8'), 10);
const SETTLE_MS = parseInt(arg('settle', '12000'), 10);
const OUT = arg('out', null);
const BOX = arg('box', null); // "x0,y0,x1,y1" in screenshot coordinates
/** Ship-relative stands: park the hull at a fixed world pose and stand at a
 *  fixed offset from it, so a sweep's chunks all photograph one framing. */
const PARK = {
  'deck-aft': { dx: 0, dz: 0, dy: 4.2, yaw: Math.PI, pitch: -0.05 },
  'hull-alongside': { dx: 15, dz: 0, dy: 1.2, yaw: -Math.PI / 2, pitch: 0.02 },
};
const ONLY = arg('only', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
/** Narrow to materials reached through a named owner. 517 materials are drawn at
 *  `deck-aft` and ablating every one of them is 1,200 software renders; the fight
 *  under investigation is always in one part of the world and this says which. */
const OWNER = arg('owner', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
/** Ablate whole named subtrees instead of single materials — the coarse pass. */
const BY_OWNER = argv.includes('--by-owner');
/** Raycast the patch pixels and report hull-local coordinates, optionally
 *  filtered to a comma-separated list of material names. */
const PIERCE = argv.includes('--pierce')
  ? (arg('pierce', '').startsWith('--') ? [] : arg('pierce', '').split(',').filter(Boolean))
  : null;

async function health() {
  const port = SERVER_PORT ?? '8090';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function main() {
  const h = await health();
  if (!h) {
    console.error(`No game server on :${SERVER_PORT ?? '8090'}. Start your OWN on a spare port.`);
    process.exit(2);
  }
  console.log(`z-fight blame — GL: ${describeGl()}  quality=${QUALITY}  seed ${h.mapSeed ?? 'UNPINNED'}`);
  const client = await ensureDevClient(`${URL}/`);
  if (client) console.log(`  started a Vite client on :${client.port} for this run`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const report = { scene: SCENE, tod: TOD, dolly: DOLLY_M, quality: QUALITY, rows: [] };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 200)}`));
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 90_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 300_000 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => window.__piratesBR.setBotPeace(true));
    await page.evaluate(PIN_PROBE_RESOLUTION);

    const world = await readWorld(page);
    const stand = planStands(world, [SCENE])[0];
    if (!stand) throw new Error(`no stand ${SCENE}`);

    const park = PARK[SCENE] ? { ...PARK[SCENE], tod: TIME_OF_DAY[TOD] } : null;
    const place = async () => {
      if (park) return; // BLAME_SWEEP parks inside its own task; see zfight-blame.mjs
      const placed = await page.evaluate(PLACE_AND_SETTLE, { ...stand.cam, tod: TIME_OF_DAY[TOD] });
      await page.evaluate(PLACE_AND_SETTLE, {
        ...stand.cam,
        x: placed.x + Math.sin(placed.yaw) * DOLLY_M,
        y: placed.y,
        z: placed.z + Math.cos(placed.yaw) * DOLLY_M,
        yaw: placed.yaw,
        aimAt: null,
        tod: TIME_OF_DAY[TOD],
      });
    };
    await place();
    // FIND A POSE THE FIGHT IS ACTUALLY VISIBLE AT before spending renders on
    // ablations. A coplanar pair is one depth level apart at one eye position and
    // TIED a few centimetres later; a sweep started at the first is a sweep of a
    // clean frame that can blame nobody.
    if (park) {
      let best = null;
      // ALONG THE VIEW DIRECTION, not along z. The dolly's whole job is to land
      // on a different phase of the depth grid at the SAME view; stepping
      // sideways at a stand that looks down -x changes the picture instead.
      for (const d of [0, 0.17, 0.41, 0.83, 1.29, -0.31]) {
        const probe = {
          ...park,
          dx: (park.dx ?? 0) + Math.sin(park.yaw) * d,
          dz: (park.dz ?? 0) + Math.cos(park.yaw) * d,
        };
        const out = await page.evaluate(BLAME_SWEEP, { uuids: [], park: probe });
        if (out.error) throw new Error(out.error);
        console.log(`  scan +${d.toFixed(2).padStart(5)}m  ties ${String(out.base.ties).padStart(5)} `
          + `patch ${String(out.base.patch).padStart(5)}  self-noise ${out.selfNoise}`);
        if (!best || out.base.patch > best.patch) best = { patch: out.base.patch, d };
      }
      park.dx = (park.dx ?? 0) + Math.sin(park.yaw) * best.d;
      park.dz = (park.dz ?? 0) + Math.cos(park.yaw) * best.d;
      console.log(`  sweeping at +${best.d}m (patch ${best.patch})\n`);
    }

    const box = BOX ? (([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }))(BOX.split(',').map(Number)) : null;

    // WHERE ON THE HULL. Ablation names the materials; this names the surfaces.
    if (PIERCE) {
      const out = await page.evaluate(BLAME_SWEEP, { uuids: [], park, box });
      if (out.error) throw new Error(out.error);
      console.log(`  patch ${out.base.patch} at (${out.base.cx},${out.base.cy}); `
        + `${out.base.samples.length} sample pixels\n`);
      const pierced = await page.evaluate(PIERCE_LOCAL, {
        points: out.base.samples,
        width: out.width,
        height: out.height,
        materials: PIERCE.length ? PIERCE : null,
        park,
      });
      for (const p of pierced) {
        console.log(`    (${String(p.x).padStart(3)},${String(p.y).padStart(3)})  `
          + p.hits.map((hh) => `${hh.material}@${hh.d} local(${hh.lx},${hh.ly},${hh.lz}) n${JSON.stringify(hh.n)}`).join('\n                 '));
      }
      report.pierced = pierced;
      if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
      return;
    }

    // COARSE PASS: which named subtree owns the fight. Cheap enough to run over
    // the whole scene, which the material sweep is not.
    if (BY_OWNER) {
      const listing = await page.evaluate(BLAME_SWEEP, { uuids: [], park, box, listOwners: true });
      const owners = listing.owners.map((o) => o.owner);
      console.log(`  ${owners.length} named owners; baseline patch ${listing.base.patch}\n`);
      for (let i = 0; i < owners.length; i += CHUNK) {
        const out = await page.evaluate(BLAME_SWEEP, { owners: owners.slice(i, i + CHUNK), park, box });
        if (out.error) throw new Error(out.error);
        for (const r of out.results) {
          const dropped = out.base.patch - r.patch;
          report.rows.push({ ...r, basePatch: out.base.patch, dropped });
          if (dropped !== 0) {
            console.log(`    ${String(r.owner).padEnd(30)} hidden(${String(r.nodes).padStart(4)})  `
              + `patch ${String(out.base.patch).padStart(5)} -> ${String(r.patch).padStart(5)}  `
              + `ties ${String(out.base.ties).padStart(5)} -> ${String(r.ties).padStart(5)}`);
          }
        }
        console.log(`  ..${Math.min(i + CHUNK, owners.length)}/${owners.length} (base ${out.base.patch})`);
      }
      report.rows.sort((p, q) => q.dropped - p.dropped);
      console.log('\n  most blame (patch pixels removed by hiding this subtree alone):');
      for (const r of report.rows.slice(0, 12)) {
        console.log(`    ${String(r.dropped).padStart(6)}  ${r.owner}`);
      }
      if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
      return;
    }

    let mats = await page.evaluate(LIST_MATERIALS);
    if (ONLY) mats = mats.filter((m) => ONLY.some((n) => (m.name || m.type).includes(n)));
    if (OWNER) mats = mats.filter((m) => m.owners.some((o) => OWNER.some((n) => o.includes(n))));
    console.log(`  ${mats.length} drawn materials at ${SCENE}/${TOD} +${DOLLY_M}m\n`);

    const byUuid = new Map(mats.map((m) => [m.uuid, m]));
    let base = null;
    for (let i = 0; i < mats.length; i += CHUNK) {
      const slice = mats.slice(i, i + CHUNK);
      await place();
      const out = await page.evaluate(BLAME_SWEEP, { uuids: slice.map((m) => m.uuid), box, park });
      if (out.error) throw new Error(out.error);
      if (!base) base = out.base;
      console.log(`  [${i}] baseline: ties ${out.base.ties} patch ${out.base.patch} loud ${out.base.loud} `
        + `centre (${out.base.cx},${out.base.cy})  self-noise ${out.selfNoise}`);
      for (const r of out.results) {
        const m = byUuid.get(r.uuid);
        const dropped = out.base.patch - r.patch;
        report.rows.push({ ...r, name: m.name, type: m.type, owners: m.owners, basePatch: out.base.patch, dropped });
        if (dropped > 0 || r.patch === 0) {
          console.log(`    ${String(m.name || m.type).padEnd(28)} hidden(${String(r.nodes).padStart(3)})  `
            + `patch ${String(out.base.patch).padStart(5)} -> ${String(r.patch).padStart(5)}  `
            + `ties ${String(out.base.ties).padStart(5)} -> ${String(r.ties).padStart(5)}   ${m.owners.join(',')}`);
        }
      }
      console.log(`  ..${Math.min(i + CHUNK, mats.length)}/${mats.length}`);
    }
    report.base = base;
    report.rows.sort((p, q) => q.dropped - p.dropped);
    console.log('\n  most blame (patch pixels removed by hiding this material alone):');
    for (const r of report.rows.slice(0, 10)) {
      console.log(`    ${String(r.dropped).padStart(6)}  ${String(r.name || r.type).padEnd(28)} ${r.owners.join(',')}`);
    }
  } finally {
    await browser.close().catch(() => {});
    stopDevClient(client);
  }
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

await main();
