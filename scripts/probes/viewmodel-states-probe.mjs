// PROBE, not a gate: VIEWMODEL STATE PROBE — "does every weapon and tool have HANDS on it, in every state, and does the cutlass swing actually read?" Reproduces (and th...
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// VIEWMODEL STATE PROBE — "does every weapon and tool have HANDS on it, in every
// state, and does the cutlass swing actually read?"
//
// Reproduces (and then verifies fixes for):
//   #1 hand-less floating props: axe/cutlass/blunderbuss drawn with no fists.
//   #2 unreadable cutlass swing: rest vs mid-slash nearly identical; the
//      follow-through must keep the blade in shot through p ≈ 0.55.
//   #3 no incoming-damage feedback (the hurt vignette must fire for ANY health
//      or armour loss, and point at the shooter).
//   #4 capstan crank hands unreadable while raising the anchor.
//
// Every frame it renders is DETERMINISTIC: the animation phase is pinned by
// wrapping ViewmodelController.syncLocalViewWeapon, so the pin can never be
// scrubbed by a 10Hz snapshot landing between the pin and the screenshot. Each
// capture is saved twice — with the HUD, and with the HUD hidden so the
// viewmodel silhouette can be read on its own.
//
// node scripts/viewmodel-states-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'test-results/viewmodel-states';
// Optional section filter so a single defect can be re-verified without paying
// for the whole 10-minute sweep: weapons | tools | cutlass | damage | capstan.
const ONLY = (process.argv[3] ?? 'all').split(',');
const run = (name) => ONLY.includes('all') || ONLY.includes(name);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);

// Concurrent agents editing this tree make vite full-reload the tab mid-probe.
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

// `visibility` (not opacity — the HUD has opacity transitions, so an
// opacity-0 request was still half-painted in the very next screenshot).
const setHud = (on) => page.evaluate((v) => {
  for (const el of document.querySelectorAll('#hud, #debug-overlay, [id*="debug"], #damage-indicator-layer')) {
    el.style.visibility = v ? '' : 'hidden';
  }
}, on);

/** Full frame + a HUD-free 640×480 crop of the viewmodel region. */
async function shot(n) {
  await page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
  await setHud(false);
  await page.screenshot({ path: `${OUT}/${n}-vm.png`, clip: { x: 320, y: 180, width: 700, height: 540 }, timeout: 60_000 });
  await setHud(true);
}

async function join() {
  await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
  // Several agents' probes hammer one dev server; the loading screen can sit for
  // a minute before the menu is even visible.
  await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 180_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
  await wait(2500);
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
}
await join();

/** Walk inland until we're on dry land again — a probe that stands still on a
 *  spawn beach for four minutes ends up swimming, and a swimming pirate can't
 *  switch weapon slots at all (silent no-op), which fakes every later result. */
async function ensureAshore() {
  for (let i = 0; i < 80; i++) {
    const s = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      if (!me) return { state: 'gone' };
      if (me.state === 'alive') return { state: 'alive' };
      // Head for the nearest island centre and swim/walk in.
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
      return { state: me.state, d: best ? +best.d.toFixed(1) : null };
    });
    if (s.state === 'alive') break;
    await wait(220);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await wait(400);
  // Look out to open water/sky so the viewmodel silhouette is unambiguous.
  await page.evaluate(() => window.__piratesBR.input.setLook(0.4, -0.1));
  await wait(200);
}
await ensureAshore();

const report = { handVisibility: [], cutlassSwing: [], damage: {}, capstan: {} };

/** Palm NDC + on-screen flag for every first-person hand currently drawn. */
const handProbe = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const vm = g.viewmodel;
  const cam = g.renderer.camera;
  cam.updateMatrixWorld(true);
  const V = Object.getPrototypeOf(cam.position).constructor;
  const out = [];
  const roots = { weapon: vm.localViewWeaponRoot, pocket: vm.localViewPocketRoot, hands: vm.localViewHandsRoot };
  const anyVisible = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
  for (const [rootName, root] of Object.entries(roots)) {
    for (const name of ['view-hand-left', 'view-hand-right']) {
      const hand = root.getObjectByName(name);
      if (!hand) continue;
      const v = new V();
      v.setFromMatrixPosition(hand.children[0].matrixWorld);
      v.project(cam);
      out.push({
        root: rootName, hand: name.replace('view-hand-', ''),
        visible: anyVisible(hand),
        ndc: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(3)],
        onScreen: anyVisible(hand) && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z > -1 && v.z < 1,
      });
    }
  }
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return {
    hands: out,
    weaponRootVisible: vm.localViewWeaponRoot.visible,
    pocketRootVisible: vm.localViewPocketRoot.visible,
    handsRootVisible: vm.localViewHandsRoot.visible,
    weaponId: vm.localViewWeaponId,
    pocketKind: vm.localViewPocketKind,
    tool: me?.equippedTool ?? null,
    state: me?.state ?? null,
  };
});

const record = (label, snap) => {
  const rows = snap.hands.filter((h) => h.visible);
  const off = rows.filter((h) => !h.onScreen).map((h) => `${h.root}.${h.hand}${JSON.stringify(h.ndc)}`);
  report.handVisibility.push({ label, ...snap, drawnHands: rows.length, offScreen: off });
  console.log(`${label.padEnd(26)} weap=${snap.weaponId ?? '-'} pocket=${snap.pocketKind ?? '-'} st=${snap.state} hands=${rows.map((h) => `${h.root}.${h.hand}${h.onScreen ? '' : '!OFF'}${JSON.stringify(h.ndc.slice(0, 2))}`).join(' ') || '**NONE**'}`);
};

async function equipSlot(slot) {
  // Re-request until the SERVER agrees. Gating the retry on the viewmodel's
  // weapon id instead (as an earlier version did) re-pressed the same slot every
  // 280ms forever and the switch never landed at all.
  // A weapon-slot press is ALSO what clears an equipped tool (Match.ts:1405), and
  // the pocket viewmodel wins over the weapon viewmodel — so "activeSlot is
  // already right, skip the press" left a compass in frame for the whole cutlass
  // section. Press until BOTH the slot is right and no tool is held.
  for (let i = 0; i < 14; i++) {
    const ok = await page.evaluate((s) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      if (me?.activeSlot === s && me?.equippedTool == null) return true;
      g.input.slotPressed = s;
      return false;
    }, slot);
    await wait(280);
    if (ok) break;
  }
  await wait(450);
  return page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    return { slot: me?.activeSlot, weaponId: me?.weapons?.[me.activeSlot]?.weaponId, vm: g.viewmodel.localViewWeaponId };
  });
}

/** Tool wheel slices (Game.toolWheelSlot): spyglass 0, compass 1, bucket 2,
 *  shovel 7, lantern 8, axe 9. */
async function equipTool(wheelSlot, expected) {
  for (let i = 0; i < 14; i++) {
    await page.evaluate((s) => { window.__piratesBR.input.queueWheelSlot(s); }, wheelSlot);
    await wait(300);
    const got = await page.evaluate(() => window.__piratesBR.state.players.find((p) => p.id === window.__piratesBR.localPlayerId)?.equippedTool ?? null);
    if (got === expected) return got;
  }
  return page.evaluate(() => window.__piratesBR.state.players.find((p) => p.id === window.__piratesBR.localPlayerId)?.equippedTool ?? null);
}

// ── PIN: wrap syncLocalViewWeapon so the frame we screenshot IS the frame we
// asked for (weapon fields + reload phase forced immediately before the pose).
async function installPin() {
  await page.evaluate(() => {
    const vm = window.__piratesBR.viewmodel;
    if (vm.__pinInstalled) return;
    vm.__pinInstalled = true;
    vm.__pinFields = null;
    vm.__pinPhase = null;
    const orig = vm.syncLocalViewWeapon.bind(vm);
    let phase = 0;
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
}
const pin = (fields, phase) => page.evaluate(([f, p]) => {
  const vm = window.__piratesBR.viewmodel;
  vm.__pinFields = f;
  vm.__pinPhase = p;
}, [fields, phase]);
const unpin = () => pin(null, null);
await installPin();

// ═══ 1. HAND VISIBILITY ACROSS WEAPONS + STATES ═══════════════════════════
console.log('\n── weapons: rest / fire / reload ──');
for (const slot of run('weapons') ? [0, 1, 2, 3] : []) {
  await ensureAshore();
  const eq = await equipSlot(slot);
  if (!eq.weaponId) { console.log(`slot ${slot}: empty`); continue; }
  const id = eq.weaponId;
  if (eq.vm !== id) console.log(`  !! slot ${slot}: viewmodel still showing ${eq.vm}`);
  await unpin();
  await wait(300);
  record(`${id}-rest`, await handProbe());
  await shot(`w-${id}-rest`);
  if (id === 'cutlass') continue; // its own section below

  await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
  await wait(100);
  record(`${id}-fire`, await handProbe());
  await shot(`w-${id}-fire`);
  await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
  await wait(250);

  for (const p of [0.15, 0.35, 0.55, 0.8]) {
    await pin({ reloading: true, ammo: 0, reloadTimer: 0.5 }, p);
    await wait(300);
    record(`${id}-reload-${p}`, await handProbe());
    await shot(`w-${id}-reload-${String(p).replace('.', '')}`);
  }
  await unpin();
  await wait(300);
}

// ── TOOLS ───────────────────────────────────────────────────────────────────
console.log('\n── tools ──');
for (const [wheelSlot, name] of run('tools') ? [[9, 'axe'], [7, 'shovel'], [8, 'lantern'], [2, 'bucket'], [1, 'compass']] : []) {
  await ensureAshore();
  const got = await equipTool(wheelSlot, name);
  if (got !== name) { console.log(`tool ${name}: wheel slot ${wheelSlot} gave "${got}" — skipped`); continue; }
  await wait(400);
  record(`${name}-rest`, await handProbe());
  await shot(`t-${name}-rest`);
  await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
  for (let f = 0; f < 6; f++) {
    await wait(60);
    record(`${name}-swing-f${f}`, await handProbe());
    await shot(`t-${name}-swing-f${f}`);
  }
  await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
  await wait(250);
}
if (run('cutlass')) {
// ═══ 2. CUTLASS SWING READABILITY ════════════════════════════════════════
console.log('\n── cutlass swing frames ──');
await ensureAshore();
const cutlassSlot = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return me.weapons.findIndex((w) => w?.weaponId === 'cutlass');
});
const eqc = await equipSlot(cutlassSlot);
console.log('cutlass slot:', cutlassSlot, JSON.stringify(eqc));

const pinSwing = async (p, kind, side) => {
  await page.evaluate(([prog, k]) => {
    const g = window.__piratesBR;
    g.getCutlassSwingProgress = () => prog;
    const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
    g.cutlassSwingKind.set(me.id, k);
  }, [p, kind]);
  await wait(140);
  // The pin's rising edge flips the diagonal — force the side AFTER the flip.
  await page.evaluate((s) => { window.__piratesBR.cutlassSlashSide = s; }, side);
  await wait(240);
};

/** Hilt / guard / mid-blade / tip NDC of the cutlass, plus trail state. */
const bladeProbe = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const vm = g.viewmodel;
  const cam = g.renderer.camera;
  cam.updateMatrixWorld(true);
  const mesh = vm.localViewWeaponRoot.getObjectByName('local-view-weapon');
  if (!mesh || vm.localViewWeaponId !== 'cutlass') return { missing: vm.localViewWeaponId };
  const V = Object.getPrototypeOf(cam.position).constructor;
  const pt = (y) => {
    const v = new V(0, y, 0);
    mesh.localToWorld(v);
    v.project(cam);
    return [+v.x.toFixed(2), +v.y.toFixed(2)];
  };
  const hand = vm.localViewWeaponRoot.getObjectByName('view-hand-right');
  let handNdc = null;
  if (hand?.visible) {
    const v = new V();
    v.setFromMatrixPosition(hand.children[0].matrixWorld);
    v.project(cam);
    handNdc = [+v.x.toFixed(2), +v.y.toFixed(2)];
  }
  return {
    hilt: pt(0), guard: pt(0.16), mid: pt(0.55), tip: pt(1.0), handNdc,
    ribbons: (vm.slashRibbons ?? []).map((r) => ({ vis: r.mesh.visible, op: +r.mat.opacity.toFixed(2) })),
    streak: vm.slashStreak ? { vis: vm.slashStreak.mesh.visible, op: +vm.slashStreak.mat.opacity.toFixed(2) } : null,
  };
});

const SWING_PS = [0.001, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48, 0.55, 0.62, 0.72, 0.85, 0.95];
for (const side of [1, -1]) {
  for (const p of SWING_PS) {
    await pinSwing(p, 'swing', side);
    const b = await bladeProbe();
    report.cutlassSwing.push({ side, p, ...b });
    const pts = b.missing ? [] : [b.hilt, b.guard, b.mid, b.tip];
    const inFrame = pts.length > 0 && pts.every((q) => Math.abs(q[0]) < 1 && Math.abs(q[1]) < 1);
    console.log(`side${side > 0 ? '+' : '-'} p=${String(p).padEnd(5)} hilt=${JSON.stringify(b.hilt)} guard=${JSON.stringify(b.guard)} mid=${JSON.stringify(b.mid)} tip=${JSON.stringify(b.tip)} hand=${JSON.stringify(b.handNdc)} allIn=${inFrame} rib=${JSON.stringify(b.ribbons)}`);
    if (side === 1) await shot(`c-slash-p${String(p).replace('.', '')}`);
  }
}
await pinSwing(0, 'swing', 1);
await shot('c-rest');
for (const p of [0.05, 0.17, 0.3, 0.45, 0.7]) {
  await pinSwing(p, 'lunge', 1);
  const b = await bladeProbe();
  report.cutlassSwing.push({ kind: 'lunge', p, ...b });
  console.log(`lunge p=${p} hilt=${JSON.stringify(b.hilt)} mid=${JSON.stringify(b.mid)} tip=${JSON.stringify(b.tip)} hand=${JSON.stringify(b.handNdc)} streak=${JSON.stringify(b.streak)}`);
  await shot(`c-dash-p${String(p).replace('.', '')}`);
}
// TRAIL RIBBON. The pose sweep above waits 380ms per pin, which is longer than
// the ribbon's whole 0.34s life — so those frames can never show it. Fire a
// fresh rising edge and sample inside the trail's lifetime instead.
{
  // Pass 1: probe only (a screenshot costs ~400ms — longer than the trail).
  await pinSwing(0, 'swing', 1);
  await wait(500);
  await page.evaluate(() => { window.__piratesBR.getCutlassSwingProgress = () => 0.3; });
  let last = 0;
  for (const ms of [60, 130, 210, 320, 500]) {
    await wait(ms - last);
    last = ms;
    const b = await bladeProbe();
    report.cutlassSwing.push({ kind: `ribbon@${ms}ms`, ribbons: b.ribbons });
    console.log(`ribbon @${ms}ms rib=${JSON.stringify(b.ribbons)}`);
  }
  // Pass 2: one frame inside the trail's life, for the pixels.
  await page.evaluate(() => { window.__piratesBR.getCutlassSwingProgress = () => 0; });
  await wait(500);
  await page.evaluate(() => { window.__piratesBR.getCutlassSwingProgress = () => 0.3; });
  await wait(120);
  await page.screenshot({ path: `${OUT}/c-ribbon-live.png`, clip: { x: 320, y: 180, width: 700, height: 540 }, timeout: 60_000 });
}

// Charge dash windup (the frame where the blade "detaches to screen centre").
await page.evaluate(() => { delete window.__piratesBR.getCutlassSwingProgress; });
await wait(300);
await page.evaluate(() => { window.__piratesBR.input.mouseButtons.add(0); });
for (const ms of [120, 240, 380]) {
  await wait(ms);
  const b = await bladeProbe();
  report.cutlassSwing.push({ kind: `charge${ms}`, ...b });
  console.log(`charge ${ms}ms hilt=${JSON.stringify(b.hilt)} tip=${JSON.stringify(b.tip)} hand=${JSON.stringify(b.handNdc)}`);
  await shot(`c-charge-${ms}`);
}
await page.evaluate(() => { window.__piratesBR.input.mouseButtons.delete(0); });
await wait(400);

}
if (run('damage')) {
// ═══ 3. INCOMING DAMAGE FEEDBACK ═════════════════════════════════════════
console.log('\n── incoming damage ──');
const damageShot = async (tag, hp, armour) => {
  await page.evaluate(([h, a]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    me.health = h;
    if (a != null && 'armor' in me) me.armor = a;
    if (a != null && 'armour' in me) me.armour = a;
  }, [hp, armour]);
  await wait(140);
  const overlay = await page.evaluate(() => {
    const hurt = [...document.body.children].filter((n) => n.style && n.style.zIndex === '92');
    const dv = document.getElementById('damage-vignette');
    return {
      hurtOverlays: hurt.length,
      hurtOpacity: hurt.length ? hurt[0].style.opacity : null,
      damageVignette: dv ? getComputedStyle(dv).opacity : null,
      arrows: document.querySelectorAll('.incoming-damage-arrow').length,
    };
  });
  console.log(`damage ${tag}: ${JSON.stringify(overlay)}`);
  report.damage[tag] = overlay;
  await page.screenshot({ path: `${OUT}/d-${tag}.png`, timeout: 60_000 });
};
await damageShot('base', 100, 100);
await damageShot('hp-50', 50, 100);
await wait(1400);
await damageShot('armour-only', 50, 40);
await wait(1400);
await damageShot('chip-5', 45, 40);
await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  me.health = 100;
});
await wait(1500);

}
if (run('capstan')) {
// ═══ 4. CAPSTAN CRANK HANDS ══════════════════════════════════════════════
console.log('\n── capstan ──');
try {
  await ensureAshore();
  let aboard = false;
  for (let i = 0; i < 160 && !aboard; i++) {
    await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      if (!sh) return;
      const stats = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[sh.type];
      const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
      let best = null;
      for (const lx of [stats.w * 0.56, -stats.w * 0.56]) {
        const lz = -stats.l * 0.18;
        const x = sh.position.x + lx * cos + lz * sin;
        const z = sh.position.z + lz * cos - lx * sin;
        const d = Math.hypot(x - me.position.x, z - me.position.z);
        if (!best || d < best.d) best = { x, z, d };
      }
      g.input.setLook(Math.atan2(best.x - me.position.x, best.z - me.position.z), best.d < 6 ? -0.1 : 0.02);
      g.input.keys.add('KeyW');
      g.input.jumpPressed = true;
    });
    await wait(200);
    const prompt = await page.evaluate(() => document.getElementById('interact-prompt')?.textContent ?? '');
    if (/Climb|Aboard/.test(prompt)) {
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
        setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 60);
      });
      await wait(300);
    }
    aboard = await page.evaluate(() => !!window.__piratesBR.state.players.find((p) => p.id === window.__piratesBR.localPlayerId)?.onShipId);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  report.capstan.aboard = aboard;
  console.log('aboard:', aboard);
  if (aboard) {
    // Walk to the capstan (shared/interactions.getAnchorControlLocal → bow
    // centreline at local z = +0.42·L) and look DOWN at the drum.
    let walk = null;
    for (let i = 0; i < 220; i++) {
      walk = await page.evaluate(() => {
        const g = window.__piratesBR;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        const sh = g.state.ships.find((s) => s.id === me?.shipId);
        if (!sh) return { d: 999 };
        const L = { sloop: 12, brigantine: 16, galleon: 22 }[sh.type] ?? 12;
        const lz = L * 0.42;
        const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
        const wx = sh.position.x + lz * sin;
        const wz = sh.position.z + lz * cos;
        const dx = wx - me.position.x, dz = wz - me.position.z;
        g.input.setLook(Math.atan2(dx, dz), -0.45);
        const d = Math.hypot(dx, dz);
        if (d > 0.7) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
        const ldx = me.position.x - sh.position.x, ldz = me.position.z - sh.position.z;
        return {
          d: +d.toFixed(2), state: me.state, onShip: !!me.onShipId,
          local: [+(ldx * cos - ldz * sin).toFixed(2), +(ldx * sin + ldz * cos).toFixed(2)],
          prompt: document.getElementById('interact-prompt')?.textContent ?? '',
        };
      });
      if (walk.d < 0.7 || /Anchor/.test(walk.prompt ?? '')) break;
      if (i % 25 === 0) console.log(`  walking to capstan: ${JSON.stringify(walk)}`);
      await wait(90);
    }
    await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
    await wait(500);
    report.capstan.walk = walk;
    console.log('at capstan:', JSON.stringify(walk));
    report.capstan.prompt = await page.evaluate(() => document.getElementById('interact-prompt')?.textContent ?? '');
    console.log('capstan prompt:', JSON.stringify(report.capstan.prompt));
    const anchored = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      return !!g.state.ships.find((s) => s.id === me?.shipId)?.anchored;
    });
    if (!anchored) {
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
        setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 80);
      });
      await wait(1000);
    }
    await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true })); });
    for (let f = 0; f < 8; f++) {
      await wait(150);
      const s = await page.evaluate(() => {
        const g = window.__piratesBR;
        const vm = g.viewmodel;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        const sh = g.state.ships.find((x) => x.id === me?.shipId);
        const cam = g.renderer.camera;
        cam.updateMatrixWorld(true);
        const V = Object.getPrototypeOf(cam.position).constructor;
        const rig = vm.capstanRig;
        const pts = [];
        if (rig) {
          for (const child of rig.children) {
            const v = new V();
            v.setFromMatrixPosition(child.matrixWorld);
            v.project(cam);
            pts.push([+v.x.toFixed(2), +v.y.toFixed(2)]);
          }
        }
        return {
          anchored: !!sh?.anchored, raise: +(sh?.anchorRaiseProgress ?? 0).toFixed(2),
          handsRootVisible: vm.localViewHandsRoot.visible, rigVisible: !!rig?.visible,
          parts: rig?.children.length ?? 0,
          onScreen: pts.filter((q) => Math.abs(q[0]) < 1 && Math.abs(q[1]) < 1).length,
          pts: pts.slice(0, 4), kind: g.visibleInteractKind ?? null,
        };
      });
      console.log(`crank f${f}: ${JSON.stringify(s)}`);
      report.capstan[`f${f}`] = s;
      await shot(`k-crank-f${f}`);
    }
    await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })); });
  }
} catch (err) {
  console.log('capstan section failed:', String(err));
  report.capstan.error = String(err);
}

}
report.errors = errors.slice(0, 20);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log(`\nshots + report.json in ${OUT}/`);
if (errors.length) console.log('console errors:', errors.slice(0, 5));
await browser.close();
