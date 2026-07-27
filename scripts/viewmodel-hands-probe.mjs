// Hands-on-every-weapon audit: for each weapon/tool and each animation state,
// project the first-person hand meshes to NDC and report whether a fist is
// actually ON SCREEN (visible + inside the frustum), then screenshot the frame.
//
// The "floating prop" bug class is NOT usually hands.visible === false — it is
// hands placed at a grip that lands off the bottom/side of the frame, or nearer
// than the near plane. Only NDC tells you which.
//
// node scripts/viewmodel-hands-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/viewmodel-hands';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 30_000 });
const wait = (ms) => page.waitForTimeout(ms);
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
// Concurrent tsx-watch restarts can eat the first join; retry rather than die.
for (let attempt = 0; attempt < 4; attempt++) {
  await page.click('#menu-solo-btn', { noWaitAfter: true }).catch(() => {});
  try {
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 20_000 });
    break;
  } catch {
    if (attempt === 3) throw new Error('never reached phase=playing');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
  }
}
await wait(3000);
await page.evaluate(() => {
  document.activeElement?.blur?.();
  window.__piratesBR.setDayNightOverride(854);
  window.__piratesBR.input.setLook(0.6, -0.05);
});

// ── Diagnostics ────────────────────────────────────────────────────────────
await page.evaluate(() => {
  const g = window.__piratesBR;
  window.__handReport = () => {
    const cam = g.renderer.camera;
    cam.updateMatrixWorld(true);
    const out = { tool: g.getLocalPlayer()?.equippedTool ?? null, weapon: null, roots: {}, hands: [] };
    const me = g.getLocalPlayer();
    out.weapon = me?.weapons?.[me.activeSlot]?.weaponId ?? null;
    out.reloading = !!me?.weapons?.[me.activeSlot]?.reloading;
    out.state = me?.state ?? null;
    for (const [name, root] of [
      ['weapon', g.viewmodel.localViewWeaponRoot],
      ['pocket', g.viewmodel.localViewPocketRoot],
      ['hands', g.viewmodel.localViewHandsRoot],
    ]) {
      out.roots[name] = { visible: root.visible, children: root.children.length };
      for (const hand of root.children) {
        if (!hand.name.startsWith('view-hand')) continue;
        // Effective visibility up the chain.
        let vis = true;
        for (let o = hand; o; o = o.parent) if (!o.visible) { vis = false; break; }
        hand.updateMatrixWorld(true);
        const pts = {};
        for (const child of hand.children) {
          const p = child.getWorldPosition(new (child.position.constructor)());
          const local = cam.worldToLocal(p.clone());
          const ndc = child.getWorldPosition(new (child.position.constructor)()).project(cam);
          pts[child.geometry?.type === 'CylinderGeometry' ? `cyl${Object.keys(pts).length}` : `box${Object.keys(pts).length}`] = {
            camZ: +local.z.toFixed(3),
            ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2), +ndc.z.toFixed(3)],
          };
        }
        // Palm is the first child of makeViewHand.
        const palm = hand.children[0];
        palm.updateMatrixWorld(true);
        const wp = palm.getWorldPosition(new (palm.position.constructor)());
        const local = cam.worldToLocal(wp.clone());
        const ndc = palm.getWorldPosition(new (palm.position.constructor)()).project(cam);
        out.hands.push({
          root: name,
          name: hand.name,
          selfVisible: hand.visible,
          effVisible: vis,
          cam: [+local.x.toFixed(3), +local.y.toFixed(3), +local.z.toFixed(3)],
          ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2), +ndc.z.toFixed(3)],
          onScreen: vis && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z > -1 && ndc.z < 1,
        });
      }
    }
    return out;
  };
});

const report = async (label) => {
  const r = await page.evaluate(() => window.__handReport());
  const lines = r.hands.map((h) => `    ${h.root}/${h.name} vis=${h.effVisible} onScreen=${h.onScreen} cam=[${h.cam}] ndc=[${h.ndc}]`);
  const txt = `${label}: weapon=${r.weapon} tool=${r.tool} reloading=${r.reloading} state=${r.state} roots=${JSON.stringify(r.roots)}\n${lines.join('\n')}`;
  console.log(txt);
  return txt;
};

const log = [];
const capture = async (label) => { log.push(await report(label)); await shot(label); };

const equipWeapon = async (digit) => {
  for (let i = 0; i < 12; i++) {
    await page.evaluate((d) => {
      // A focused text field (the pirate-name input) swallows every key — the
      // silent reason slot switches "no-op" in headless runs.
      document.activeElement?.blur?.();
      for (const target of [document, window]) {
        target.dispatchEvent(new KeyboardEvent('keydown', { code: `Digit${d}`, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { code: `Digit${d}`, bubbles: true }));
      }
    }, digit);
    await wait(260);
    const ok = await page.evaluate((d) => {
      const me = window.__piratesBR.getLocalPlayer();
      return me && me.activeSlot === d - 1 && me.equippedTool === null;
    }, digit);
    if (ok) return true;
  }
  return false;
};

const equipTool = async (kind) => {
  const slot = { spyglass: 0, compass: 1, bucket: 2, shovel: 7, lantern: 8, axe: 9 }[kind];
  for (let i = 0; i < 12; i++) {
    await page.evaluate((s) => window.__piratesBR.input.queueWheelSlot(s), slot);
    await wait(300);
    const cur = await page.evaluate(() => window.__piratesBR.getLocalPlayer()?.equippedTool ?? null);
    if (cur === kind) return true;
  }
  return false;
};

// ── WEAPONS ────────────────────────────────────────────────────────────────
const WEAPON_DIGITS = { blunderbuss: 1, eye_of_reach: 2, flintknock: 3, cutlass: 4 };
for (const [id, digit] of Object.entries(WEAPON_DIGITS)) {
  const ok = await equipWeapon(digit);
  if (!ok) { log.push(`${id}: EQUIP FAILED`); console.log(`${id}: EQUIP FAILED`); continue; }
  await wait(500);
  await capture(`w-${id}-rest`);
  if (id === 'cutlass') {
    for (const [nm, p] of [['cock', 0.1], ['cut', 0.3], ['through', 0.55], ['recover', 0.85]]) {
      await page.evaluate((t) => { window.__piratesBR.getCutlassSwingProgress = () => t; }, p);
      await wait(120);
      await page.evaluate(() => {
        const g = window.__piratesBR;
        g.cutlassSwingKind.set(g.localPlayerId, 'swing');
        g.viewmodel.cutlassSlashSide = 1;
      });
      await wait(280);
      await capture(`w-cutlass-slash-${nm}`);
    }
    for (const [nm, p] of [['windup', 0.05], ['stab', 0.17], ['carry', 0.42]]) {
      await page.evaluate((t) => { window.__piratesBR.getCutlassSwingProgress = () => t; }, p);
      await wait(120);
      await page.evaluate(() => {
        const g = window.__piratesBR;
        g.cutlassSwingKind.set(g.localPlayerId, 'lunge');
      });
      await wait(320);
      await capture(`w-cutlass-dash-${nm}`);
    }
    await page.evaluate(() => { delete window.__piratesBR.getCutlassSwingProgress; });
  } else {
    // FIRE → forces a reload; sample the reload arc.
    await page.evaluate(() => window.__piratesBR.input.mouseButtons.add(0));
    await wait(140);
    await capture(`w-${id}-fire`);
    await page.evaluate(() => window.__piratesBR.input.mouseButtons.delete(0));
    for (let i = 0; i < 6; i++) {
      await wait(320);
      const ph = await page.evaluate(() => +window.__piratesBR.viewmodel.localViewWeaponReloadPhase.toFixed(2));
      await capture(`w-${id}-reload-${String(i)}-p${ph}`);
    }
  }
}

// ── TOOLS ──────────────────────────────────────────────────────────────────
for (const kind of ['axe', 'shovel', 'lantern', 'bucket', 'compass']) {
  const ok = await equipTool(kind);
  if (!ok) { log.push(`tool ${kind}: EQUIP FAILED`); console.log(`tool ${kind}: EQUIP FAILED`); continue; }
  await wait(500);
  await capture(`t-${kind}-rest`);
  await page.evaluate(() => window.__piratesBR.input.mouseButtons.add(0));
  for (let f = 0; f < 4; f++) { await wait(110); await capture(`t-${kind}-use${f}`); }
  await page.evaluate(() => window.__piratesBR.input.mouseButtons.delete(0));
  await equipTool(kind); // toggle off
}

writeFileSync(`${OUT}/report.txt`, log.join('\n'));
await browser.close();
console.log(`\nreport + shots in ${OUT}/`);
