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
import { browserArgs } from './lib/browser-args.mjs';

// `debug` is what exposes window.__piratesBR (main.ts) — without it there is no
// Game handle at all; `forceinput` opens the fire gate without pointer lock.
const URL = 'http://127.0.0.1:3000/?debug&forceinput';
let failures = 0;
const expect = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ args: browserArgs(['--ignore-gpu-blocklist']) });
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

  /**
   * The REST pose, once it has actually arrived.
   *
   * Equipping raises the hands into frame over about half a second, and a fixed
   * post-equip wait sometimes sampled them still on the way up: the same axe
   * read y = -0.51 on eight runs and -0.69 / -0.84 on two, straddling the
   * bottom-of-frame bound and failing the suite roughly one run in five. That is
   * the probe catching an animation, not a pose that is off screen at rest.
   *
   * So: poll until two consecutive frames agree, and hand back THAT sample —
   * which is then both what the assertion reads and what the failure prints.
   * (They used to be two separate `await hands()` calls, so a failure reported a
   * different frame than the one it judged, and the evidence never matched.)
   */
  const restHands = async (budgetMs = 2500) => {
    let prev = await hands();
    for (let waited = 0; waited < budgetMs; waited += 100) {
      await wait(100);
      const now = await hands();
      const settled = prev.length === now.length
        && now.every(([x, y], i) => Math.abs(x - prev[i][0]) < 0.01 && Math.abs(y - prev[i][1]) < 0.01);
      if (settled) return now;
      prev = now;
    }
    return prev;
  };

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
    const rest = await restHands();
    expect(`${id}: fists on screen at rest`, onScreen(rest), JSON.stringify(rest));
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
    const rest = await restHands();
    expect(`${name}: fists on screen at rest`, onScreen(rest), JSON.stringify(rest));
    await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
    let worst = null;
    for (let f = 0; f < 6; f++) {
      await wait(70);
      const pts = await hands();
      if (!onScreen(pts)) worst = pts;
    }
    await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
    expect(`${name}: fists stay on screen through the swing`, worst === null, worst ? JSON.stringify(worst) : '');

    // THE SLIVER. A long tool whose shaft lies on the view axis foreshortens to
    // a few pixels behind the fists and vanishes out of its own animation. With
    // the haft along Z the shaft's angle off the axis is acos(|cos(yaw)·cos(pitch)|),
    // and the axe's old chop keys passed within 0.01° of dead-on twice a cycle —
    // once mid-strike and once through the slow recovery, which is the frame the
    // eye actually samples. Sampled densely (the bad window was ~80 ms long).
    if (name === 'axe') {
      await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
      let minDeg = 180;
      for (let f = 0; f < 40; f++) {
        await wait(24);
        const deg = await page.evaluate(() => {
          const r = window.__piratesBR.viewmodel.localViewPocketRoot.rotation;
          const along = Math.abs(Math.cos(r.y) * Math.cos(r.x));
          return (Math.acos(Math.min(1, Math.max(-1, along))) * 180) / Math.PI;
        });
        if (deg < minDeg) minDeg = deg;
      }
      await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
      expect('axe: the blade never lies down the view axis (≥15° all swing)',
        minDeg >= 15, `closest approach ${minDeg.toFixed(1)}°`);
    }
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
  // The ribbon fades in over a frame or two and then decays, so a single sample
  // at a fixed 120 ms lands inside its life only most of the time — this read
  // [0, 0] on about one run in ten. Watch the ribbon for a beat and keep the
  // BRIGHTEST frame: "a slash spawns a visible ribbon" is a claim about whether
  // it ever appears, not about its opacity at one arbitrary millisecond.
  let trail = null;
  for (let i = 0; i < 12; i++) {
    await wait(60);
    const sample = await blade();
    if (!sample) continue;
    const peak = Math.max(0, ...sample.ribbons);
    const best = trail ? Math.max(0, ...trail.ribbons) : -1;
    if (peak > best) trail = sample;
    if (peak > 0.25) break;
  }
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
  // "Phantom" means the vignette came up with NOTHING taken off you. The
  // overlay fires on any loss of health or armour from any source, and this
  // probe is a real pirate in a real match: by the time the run reaches this
  // section she can be in the water taking drowning ticks, or in the storm, or
  // being chewed on. That vignette is correct, not phantom, and failing on it
  // made this the flakiest check in the browser chain (1 run in 3 here).
  //
  // THE SETUP WAS ALSO WOUNDING HER. This window used to open with
  // bite(100, 100) — and she has no armour, so the next snapshot corrected that
  // 100 straight back to 0. The vitals watch reads armour loss as damage (that
  // is the very next assertion), so the probe's own write landed a 100-point
  // hit, raised an entirely honest vignette, and then asked whether anything
  // had hit her. Worse, `before` was sampled 120 ms later — after the
  // correction — so the guard above could not even see the loss it had caused,
  // and the check failed on 2 runs in 3.
  //
  // So: heal WITHOUT fabricating armour she does not have, wait for the screen
  // to actually go quiet, and only then start the window. A vignette that comes
  // up during the quiet window with both pools flat is the real defect.
  const vitals = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    return { health: me?.health ?? -1, armor: me?.armor ?? -1 };
  });
  const healOnly = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    if (me) me.health = 100;
  });
  /** Poll until the hurt overlay has decayed to nothing. */
  const settle = async (budgetMs) => {
    for (let waited = 0; waited <= budgetMs; waited += 200) {
      if ((await hurtOpacity()) <= 0.02) return true;
      await wait(200);
    }
    return false;
  };
  // The wounds go FIRST, so that by the time the quiet window opens the overlay
  // has genuinely been raised and is a live element on the page. Asking "is it
  // at zero?" before anything has ever built it only proves it does not exist
  // yet, which is not the invariant — the invariant is that it comes back DOWN
  // and stays down.
  expect('a 50-point wound raises the hurt vignette', (await bite(50, 100)) > 0.3, String(await hurtOpacity()));
  await wait(1600);
  expect('damage absorbed by ARMOUR still raises it', (await bite(50, 55)) > 0.2, String(await hurtOpacity()));
  await wait(1600);
  expect('a 5-point chip still registers', (await bite(45, 55)) > 0.15, String(await hurtOpacity()));

  let phantom = null;
  for (let attempt = 0; attempt < 4 && phantom === null; attempt++) {
    await healOnly();
    // The wounds above (and the world) are still fading; that is not the thing
    // under test, so give the screen time to go quiet before the window opens.
    if (!(await settle(8000))) { await wait(1200); continue; }
    const before = await vitals();
    await wait(1600);
    const [opacity, after] = [await hurtOpacity(), await vitals()];
    const hurt = after.health < before.health || after.armor < before.armor;
    // The world took a bite mid-window: nothing to judge, settle and re-sample.
    if (opacity > 0.02 && hurt) { await wait(1200); continue; }
    phantom = { opacity, before, after };
  }
  expect('the vignette settles and stays down when nothing is hitting you',
    phantom !== null && phantom.opacity <= 0.02 && phantom.opacity >= 0,
    phantom
      ? `${phantom.opacity} (health ${phantom.before.health}→${phantom.after.health}, armour ${phantom.before.armor}→${phantom.after.armor})`
      : 'the world hurt her on every attempt — could not get a clean window');
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
