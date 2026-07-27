#!/usr/bin/env node
// FIRST-PERSON POSE INVARIANTS — the screen-space contract for the viewmodel.
//
// Every defect this pins was a "looks fine in the editor, unreadable on screen"
// bug, so every assertion is a measured NDC projection of a real rendered frame,
// not a property of the code:
//
//   1. HANDS ON SCREEN. Every weapon (rest / firing / mid-reload) and every tool
//      (rest / mid-swing) draws its forearms+fists INSIDE the frame. Fists in the
//      bottom-right corner at ndc.y ≤ −0.8 sit under the HUD tiles and the prop
//      reads as a hand-less floating object — which is exactly what shipped.
//   2. CUTLASS SWING IS LEGIBLE. The mid-swing frame must not look like rest:
//      the blade tip at p ≈ 0.32 has to be far from where it sits at rest. The
//      old arc rolled the blade through vertical at mid-swing and put the tip
//      within 0.01 NDC of its rest position.
//   3. FOLLOW-THROUGH STAYS IN SHOT. Hilt, guard, mid-blade and tip all inside
//      the frame for the whole 0.55s swing, on BOTH diagonals, in particular at
//      p = 0.55.
//   4. TRAIL FIRES FIRST-PERSON. A slash spawns a visible camera-space ribbon.
//   5. INCOMING DAMAGE IS VISIBLE. Any loss of health or armour raises the
//      directional hurt overlay.
//
// node --import tsx scripts/test-viewmodel-poses.mjs
import { chromium } from 'playwright';

// `debug` is what exposes window.__piratesBR (main.ts) — without it there is no
// Game handle at all; `forceinput` opens the fire gate without pointer lock.
const URL = 'http://127.0.0.1:3000/?debug&forceinput';
let failures = 0;
const expect = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const wait = (ms) => page.waitForTimeout(ms);
// Concurrent edits to this tree make vite full-reload the tab mid-run.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\n'
    + 'export const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 180_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
  await wait(2500);
  await page.evaluate(() => {
    window.__piratesBR.setDayNightOverride(854);
    window.__piratesBR.input.setLook(0.4, -0.1);
  });

  /** Walk back onto land: a pirate left standing on a spawn beach drifts into
   *  the water, and a swimming pirate cannot change weapon slot at all. */
  const ensureAshore = async () => {
    for (let i = 0; i < 80; i++) {
      const state = await page.evaluate(() => {
        const g = window.__piratesBR;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        if (!me) return 'gone';
        if (me.state === 'alive') return 'alive';
        let best = null;
        for (const isl of g.state.islands ?? []) {
          const d = Math.hypot(isl.position.x - me.position.x, isl.position.z - me.position.z);
          if (!best || d < best.d) best = { d, x: isl.position.x, z: isl.position.z };
        }
        if (best) {
          g.input.setLook(Math.atan2(best.x - me.position.x, best.z - me.position.z), -0.05);
          g.input.keys.add('KeyW');
          g.input.jumpPressed = true;
        }
        return me.state;
      });
      if (state === 'alive') break;
      await wait(220);
    }
    await page.evaluate(() => {
      window.__piratesBR.input.keys.delete('KeyW');
      window.__piratesBR.input.setLook(0.4, -0.1);
    });
    await wait(350);
  };
  await ensureAshore();

  const hands = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const vm = g.viewmodel;
    const cam = g.renderer.camera;
    cam.updateMatrixWorld(true);
    const V = Object.getPrototypeOf(cam.position).constructor;
    const visible = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
    const out = [];
    for (const root of [vm.localViewWeaponRoot, vm.localViewPocketRoot, vm.localViewHandsRoot]) {
      for (const name of ['view-hand-left', 'view-hand-right']) {
        const hand = root.getObjectByName(name);
        if (!hand || !visible(hand)) continue;
        const v = new V();
        v.setFromMatrixPosition(hand.children[0].matrixWorld);
        v.project(cam);
        out.push([+v.x.toFixed(2), +v.y.toFixed(2)]);
      }
    }
    return out;
  });
  const onScreen = (pts) => pts.length > 0 && pts.every(([x, y]) => Math.abs(x) < 1 && y > -0.8 && y < 1);

  const equipSlot = async (slot) => {
    for (let i = 0; i < 14; i++) {
      const ok = await page.evaluate((s) => {
        const g = window.__piratesBR;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        // A weapon-slot press is also what clears an equipped tool, and the
        // pocket viewmodel wins over the weapon one.
        if (me?.activeSlot === s && me?.equippedTool == null) return true;
        g.input.slotPressed = s;
        return false;
      }, slot);
      await wait(280);
      if (ok) break;
    }
    await wait(400);
    return page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      return me?.weapons?.[me.activeSlot]?.weaponId ?? null;
    });
  };

  // Force the reload phase every frame, immediately before the pose is built.
  await page.evaluate(() => {
    const vm = window.__piratesBR.viewmodel;
    const orig = vm.syncLocalViewWeapon.bind(vm);
    let phase = 0;
    vm.__pinPhase = null;
    vm.__pinFields = null;
    Object.defineProperty(vm, 'localViewWeaponReloadPhase', {
      configurable: true,
      get() { return vm.__pinPhase == null ? phase : vm.__pinPhase; },
      set(v) { phase = v; },
    });
    vm.syncLocalViewWeapon = () => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const w = me?.weapons?.[me.activeSlot];
      if (w && vm.__pinFields) Object.assign(w, vm.__pinFields);
      orig();
    };
  });
  const pin = (fields, phase) => page.evaluate(([f, p]) => {
    const vm = window.__piratesBR.viewmodel;
    vm.__pinFields = f;
    vm.__pinPhase = p;
  }, [fields, phase]);

  console.log('First-person hands (every weapon, every state):');
  for (const slot of [0, 1, 2, 3]) {
    await ensureAshore();
    const id = await equipSlot(slot);
    if (!id) continue;
    await pin(null, null);
    await wait(300);
    expect(`${id}: fists on screen at rest`, onScreen(await hands()), JSON.stringify(await hands()));
    if (id === 'cutlass') continue;
    await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
    await wait(120);
    const firing = await hands();
    await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
    expect(`${id}: fists on screen while firing`, onScreen(firing), JSON.stringify(firing));
    for (const p of [0.35, 0.55]) {
      await pin({ reloading: true, ammo: 0, reloadTimer: 0.5 }, p);
      await wait(300);
      const r = await hands();
      expect(`${id}: fists on screen mid-reload (p=${p})`, onScreen(r), JSON.stringify(r));
    }
    await pin(null, null);
    await wait(250);
  }

  console.log('First-person hands (tools):');
  for (const [wheelSlot, name] of [[9, 'axe'], [7, 'shovel'], [2, 'bucket'], [1, 'compass']]) {
    await ensureAshore();
    let got = null;
    for (let i = 0; i < 14; i++) {
      await page.evaluate((s) => { window.__piratesBR.input.queueWheelSlot(s); }, wheelSlot);
      await wait(300);
      got = await page.evaluate(() => window.__piratesBR.state.players.find((p) => p.id === window.__piratesBR.localPlayerId)?.equippedTool ?? null);
      if (got === name) break;
    }
    if (got !== name) { console.log(`  · ${name}: could not equip (got ${got}) — skipped`); continue; }
    await wait(350);
    expect(`${name}: fists on screen at rest`, onScreen(await hands()), JSON.stringify(await hands()));
    await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
    let worst = null;
    for (let f = 0; f < 6; f++) {
      await wait(70);
      const pts = await hands();
      if (!onScreen(pts)) worst = pts;
    }
    await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
    expect(`${name}: fists stay on screen through the swing`, worst === null, worst ? JSON.stringify(worst) : '');
  }

  // ── CUTLASS ───────────────────────────────────────────────────────────────
  console.log('Cutlass swing legibility:');
  await ensureAshore();
  const cutlassSlot = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    return me.weapons.findIndex((w) => w?.weaponId === 'cutlass');
  });
  const equipped = await equipSlot(cutlassSlot);
  expect('cutlass equips', equipped === 'cutlass', String(equipped));

  const blade = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const vm = g.viewmodel;
    const cam = g.renderer.camera;
    cam.updateMatrixWorld(true);
    const mesh = vm.localViewWeaponRoot.getObjectByName('local-view-weapon');
    if (!mesh || vm.localViewWeaponId !== 'cutlass') return null;
    const V = Object.getPrototypeOf(cam.position).constructor;
    const pt = (y) => {
      const v = new V(0, y, 0);
      mesh.localToWorld(v);
      v.project(cam);
      return [+v.x.toFixed(3), +v.y.toFixed(3)];
    };
    return {
      hilt: pt(0), guard: pt(0.16), mid: pt(0.55), tip: pt(1),
      ribbons: (vm.slashRibbons ?? []).map((r) => (r.mesh.visible ? +r.mat.opacity.toFixed(2) : 0)),
    };
  });
  const pinSwing = async (p, side) => {
    await page.evaluate((prog) => {
      const g = window.__piratesBR;
      g.getCutlassSwingProgress = () => prog;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      g.cutlassSwingKind.set(me.id, 'swing');
    }, p);
    await wait(130);
    // The pin's rising edge flips the diagonal; force the side AFTER the flip.
    await page.evaluate((s) => { window.__piratesBR.cutlassSlashSide = s; }, side);
    await wait(230);
  };

  await pinSwing(0, 1);
  const rest = await blade();
  expect('cutlass rest pose measurable', !!rest, JSON.stringify(rest));
  if (rest) {
    for (const side of [1, -1]) {
      let restLike = null;
      let offFrame = null;
      let atP055 = null;
      for (const p of [0.001, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48, 0.55, 0.62, 0.72, 0.85, 0.95]) {
        await pinSwing(p, side);
        const b = await blade();
        if (!b) continue;
        const pts = [b.hilt, b.guard, b.mid, b.tip];
        if (!pts.every(([x, y]) => Math.abs(x) < 1 && Math.abs(y) < 1)) offFrame = { p, ...b };
        if (p === 0.55) atP055 = b;
        // The frames the eye actually samples (the cut) must not be the rest pose.
        if (p >= 0.3 && p <= 0.5) {
          const d = Math.hypot(b.tip[0] - rest.tip[0], b.tip[1] - rest.tip[1]);
          if (d < 0.45) restLike = { p, d: +d.toFixed(3), tip: b.tip, restTip: rest.tip };
        }
      }
      const s = side > 0 ? 'right-to-left' : 'left-to-right';
      expect(`${s}: whole blade stays in frame for the whole swing`, offFrame === null, offFrame ? JSON.stringify(offFrame) : '');
      expect(`${s}: mid-swing does not look like rest`, restLike === null, restLike ? `tip only ${restLike.d} NDC from rest at p=${restLike.p}` : '');
      expect(`${s}: blade still in shot at p=0.55`, !!atP055 && [atP055.hilt, atP055.guard, atP055.mid, atP055.tip].every(([x, y]) => Math.abs(x) < 1 && Math.abs(y) < 1), JSON.stringify(atP055));
    }
  }

  // Trail: fire a fresh rising edge and sample INSIDE the ribbon's lifetime
  // (a screenshot round-trip is longer than the trail, so probe only).
  await pinSwing(0, 1);
  await wait(400);
  await page.evaluate(() => { window.__piratesBR.getCutlassSwingProgress = () => 0.3; });
  await wait(120);
  const trail = await blade();
  expect('slash spawns a visible first-person trail ribbon',
    !!trail && trail.ribbons.some((op) => op > 0.25), JSON.stringify(trail?.ribbons));
  await page.evaluate(() => { delete window.__piratesBR.getCutlassSwingProgress; });
  await wait(300);

  // ── INCOMING DAMAGE ───────────────────────────────────────────────────────
  console.log('Incoming damage feedback:');
  const hurtOpacity = () => page.evaluate(() => {
    const el = [...document.body.children].find((n) => n.style && n.style.zIndex === '92');
    return el ? Number(el.style.opacity || '0') : -1;
  });
  const bite = async (health, armor) => {
    await page.evaluate(([h, a]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      me.health = h;
      me.armor = a;
    }, [health, armor]);
    await wait(120);
    return hurtOpacity();
  };
  await bite(100, 100);
  await wait(1600);
  expect('no phantom vignette when nothing hit you', (await hurtOpacity()) <= 0.02, String(await hurtOpacity()));
  expect('a 50-point wound raises the hurt vignette', (await bite(50, 100)) > 0.3, String(await hurtOpacity()));
  await wait(1600);
  expect('damage absorbed by ARMOUR still raises it', (await bite(50, 55)) > 0.2, String(await hurtOpacity()));
  await wait(1600);
  expect('a 5-point chip still registers', (await bite(45, 55)) > 0.15, String(await hurtOpacity()));
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    me.health = 100;
  });
} catch (err) {
  console.log(`  ✗ probe crashed — ${String(err).split('\n')[0]}`);
  failures += 1;
} finally {
  await browser.close();
}

console.log(failures === 0
  ? '\nEvery weapon has hands on it, the slash reads, and being hit is unmistakable.'
  : `\n${failures} viewmodel pose invariant(s) broken.`);
process.exit(failures === 0 ? 0 : 1);
