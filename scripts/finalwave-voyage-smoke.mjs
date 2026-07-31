// FINAL WAVE CROSS-SMOKE — THE VOYAGE (checks e, i, j, n).
//
//   (e) THE HELM READS A LIVE SPEED. The ship card used to advertise "TOP SPEED
//       15.0 kn" — a stat-sheet ceiling in world units wearing a knots label. The
//       panel must now be |velocity| × 1.94384 and nothing else, and the proof has
//       to be taken on ONE frame: force the HUD to paint, then read the velocity
//       and the string it just painted in the same evaluate. Sampling them a
//       second apart makes an honest readout look like a lie by exactly one tick
//       of lag, which is how the endgame rig's own version of this check fails.
//   (i) OWN-SHIP IDENTITY at sailing range: the gold masthead swallowtail and the
//       "YOUR …" card title, photographed from under 50 m off her own beam.
//   (j) THE SPAWN BEACH in pixels: barrels visible from the dock, and a dig-site
//       tell legible at 30 m. The wire probe proves the objects exist; only a
//       frame proves you can see them.
//   (n) RAIN UNDER A LIVE REPLICATED STORM — not ?stormdemo, which hard-sets the
//       weather to 0.7 and was for a long time the only path that closed the cloud
//       deck at all. She sails OUT through her own ring and the sky is
//       photographed on the way: blue sky must be dry, and every drop must fall
//       out of a darkened, tinted deck.
//
// Software ANGLE only, one browser, small viewport — this box panics under a
// GPU-headless Chromium. Captures carry their own pixel statistics so a flat
// non-render cannot be mistaken for evidence.
//
//   PHASES=j,i node scripts/finalwave-voyage-smoke.mjs   (the fast dock claims)
//   PHASES=e,n node scripts/finalwave-voyage-smoke.mjs   (sail out into the wall)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PHASES = new Set((process.env.PHASES ?? 'j,i,e,n').split(',').map((x) => x.trim()).filter(Boolean));
const phase = (id) => PHASES.has(id);
const SETTLE = Number(process.env.SETTLE_MS ?? 1400);
const DEADLINE = Date.now() + Number(process.env.BUDGET_MS ?? 520_000);
const left = () => DEADLINE - Date.now();

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/finalwave/smoke/voyage';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter'],
});
let closed = false;
const reap = () => { if (closed) return; closed = true; try { browser.process()?.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); reap(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); reap(); process.exit(1); });

const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const ok = (label, pass, detail = '') => { results.push({ label, pass, detail }); console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); };
const say = (m) => console.log(m);

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));
await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ } });

await page.goto('http://127.0.0.1:3000/?debug&forceinput&peace', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
await wait(2500);
await page.evaluate(() => { document.getElementById('oc-skip')?.click(); });
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await wait(800);

const look = (p, t) => page.evaluate(([a, b]) => {
  const g = window.__piratesBR;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  g.enableFreeCam(a[0], a[1], a[2], Math.atan2(dx / len, dz / len), Math.asin(dy / len));
}, [p, t]);

const capture = async (name, box = null) => {
  const png = await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 120_000 });
  const stats = await page.evaluate(async ([dataUrl, b]) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const cv = document.createElement('canvas');
    cv.width = 240; cv.height = 135;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 240, 135);
    const d = ctx.getImageData(0, 0, 240, 135).data;
    const lum = []; const rgb = [];
    for (let i = 0; i < d.length; i += 4) {
      lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      rgb.push([d[i], d[i + 1], d[i + 2]]);
    }
    const mean = lum.reduce((a, x) => a + x, 0) / lum.length;
    const sd = Math.sqrt(lum.reduce((a, l) => a + (l - mean) ** 2, 0) / lum.length);
    let boxStats = null;
    if (b) {
      const x0 = Math.round(b[0] * 240), x1 = Math.round(b[2] * 240);
      const y0 = Math.round(b[1] * 135), y1 = Math.round(b[3] * 135);
      const v = []; let blueSum = 0, n = 0, satSum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = y * 240 + x; v.push(lum[i]);
        const [r, g2, bl] = rgb[i];
        blueSum += bl - r; satSum += Math.max(r, g2, bl) - Math.min(r, g2, bl); n++;
      }
      const bm = v.reduce((a, x) => a + x, 0) / v.length;
      v.sort((p, q) => p - q);
      boxStats = {
        mean: +bm.toFixed(2), p05: +v[Math.floor(v.length * 0.05)].toFixed(2),
        p50: +v[Math.floor(v.length * 0.5)].toFixed(2), p95: +v[Math.floor(v.length * 0.95)].toFixed(2),
        // A CLEAR TROPICAL SKY IS BLUE AND SATURATED; an overcast storm deck is
        // grey, dark and desaturated. These two numbers are what separates them.
        blueness: +(blueSum / n).toFixed(2), sat: +(satSum / n).toFixed(2),
      };
    }
    return { mean: +mean.toFixed(2), sd: +sd.toFixed(2), box: boxStats };
  }, [`data:image/png;base64,${png.toString('base64')}`, box]);
  say(`  [${name}] sd=${stats.sd} mean=${stats.mean}${stats.box ? ` sky=${JSON.stringify(stats.box)}` : ''}`);
  return stats;
};

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const st = g.state.storm;
  const d = me ? Math.hypot(me.position.x - st.centerX, me.position.z - st.centerZ) : null;
  return {
    t: +(g.state.serverTime ?? 0).toFixed(0), hp: me ? +me.health.toFixed(1) : null,
    state: me?.state, atHelm: !!me?.atHelm, onShip: !!me?.onShipId,
    anchored: !!ship?.anchored, sail: +(ship?.sailHeight ?? 0).toFixed(2),
    speed: +Math.hypot(ship?.velocity.x ?? 0, ship?.velocity.z ?? 0).toFixed(2),
    safe: +st.safeRadius.toFixed(0), playerD: d === null ? null : +d.toFixed(0),
    outside: d === null ? null : +(d - st.safeRadius).toFixed(0),
    stormPhase: st.phase,
  };
});
const shots = {};

// ══ (j) THE SPAWN BEACH, IN PIXELS ═══════════════════════════════════════════
if (phase('j')) {
  say('\n(j) the spawn beach: barrels from the dock, a dig tell at 30 m');
  const site = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const isle = (g.state.islands ?? [])
      .map((i) => ({ i, d: Math.hypot(i.position.x - me.position.x, i.position.z - me.position.z) }))
      .sort((a, b) => a.d - b.d)[0]?.i;
    const barrels = (isle?.barrels ?? []).filter((b) => !b.opened)
      .map((b) => ({ x: b.position.x, y: b.position.y, z: b.position.z, d: Math.hypot(b.position.x - me.position.x, b.position.z - me.position.z) }))
      .sort((a, b) => a.d - b.d);
    const digs = (isle?.chests ?? []).filter((c) => c.buried && !c.dug)
      .map((c) => ({ x: c.position.x, y: c.position.y, z: c.position.z, d: Math.hypot(c.position.x - me.position.x, c.position.z - me.position.z) }))
      .sort((a, b) => a.d - b.d);
    return {
      isle: isle?.name, me: { x: me.position.x, y: me.position.y, z: me.position.z },
      dock: isle?.dock ? { x: isle.dock.respawnPoint.x, y: isle.dock.respawnPoint.y, z: isle.dock.respawnPoint.z } : null,
      barrels: barrels.slice(0, 6), digs: digs.slice(0, 4),
    };
  });
  say(`  ${site.isle}: nearest barrel ${site.barrels[0]?.d.toFixed(0)} m, nearest dig ${site.digs[0]?.d.toFixed(0)} m`);
  // Standing where a pirate lands, looking at the nearest cluster of stores.
  const eye = site.dock ?? site.me;
  const b0 = site.barrels[0];
  if (b0) {
    await look([eye.x, eye.y + 1.7, eye.z], [b0.x, b0.y + 0.6, b0.z]);
    await wait(SETTLE);
    shots['j-barrels-from-dock'] = await capture('j-barrels-from-dock');
  }
  // THE TELL THE CLIENT IS ACTUALLY DRAWING, not the chest the server knows about.
  // A buried chest with no mound showing is not a tell, and aiming a camera at one
  // photographs bare hillside — which is how the first run of this check "failed"
  // a tell that was never in frame. chestMeshes carries the mound the renderer put
  // up; its matrixWorld is the only honest world point for it.
  const tell = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    let best = null;
    for (const [, rec] of g.chestMeshes ?? []) {
      if (!rec?.mound?.visible) continue;
      rec.mound.updateWorldMatrix(true, false);
      const e = rec.mound.matrixWorld.elements;
      const p = { x: e[12], y: e[13], z: e[14] };
      const dist = Math.hypot(p.x - me.position.x, p.z - me.position.z);
      const sparkle = rec.mound.userData?.digSparkle ?? null;
      if (!best || dist < best.dist) {
        best = { ...p, dist: +dist.toFixed(1), sparkle: !!sparkle, opacity: sparkle ? +(sparkle.material?.opacity ?? 0).toFixed(2) : null };
      }
    }
    return best;
  });
  say(`  nearest DRAWN dig tell: ${JSON.stringify(tell)}`);
  const d0 = tell ?? site.digs[0];
  if (d0) {
    // Exactly 30 m off, eye height, the tell dead centre.
    const bx = d0.x - eye.x, bz = d0.z - eye.z; const bl = Math.hypot(bx, bz) || 1;
    const gy = await page.evaluate(([x, z]) => +window.__piratesBR.sampleGroundY(x, z).toFixed(2),
      [d0.x - (bx / bl) * 30, d0.z - (bz / bl) * 30]);
    await look([d0.x - (bx / bl) * 30, gy + 1.7, d0.z - (bz / bl) * 30], [d0.x, d0.y + 0.3, d0.z]);
    await wait(SETTLE);
    // The HUD's centre furniture sits exactly where the tell is aimed, so the
    // frame that decides whether a tell is legible cannot have chrome over it.
    await page.evaluate(() => {
      const e = document.createElement('style'); e.id = 'fw-hide-hud';
      e.textContent = '#hud{visibility:hidden!important;}';
      document.head.appendChild(e);
    });
    await wait(400);
    shots['j-dig-tell-30m'] = await capture('j-dig-tell-30m', [0.4, 0.42, 0.6, 0.68]);
    // …and again at ten metres, so a tell that is merely small at thirty can be
    // told apart from one that is not being drawn at all.
    await look([d0.x - (bx / bl) * 10, gy + 1.7, d0.z - (bz / bl) * 10], [d0.x, d0.y + 0.2, d0.z]);
    await wait(SETTLE);
    shots['j-dig-tell-10m'] = await capture('j-dig-tell-10m', [0.35, 0.4, 0.65, 0.75]);
    await page.evaluate(() => document.getElementById('fw-hide-hud')?.remove());
  }
  // `tell` measures itself in `dist`, the server chest in `d` — one of them is
  // whichever was available, so the report reads both rather than assuming.
  const tellDist = tell?.dist ?? site.digs[0]?.d ?? null;
  ok('the spawn beach has stores and a DRAWN dig tell to photograph',
    !!b0 && !!d0 && b0.d < 90 && (tell?.sparkle ?? false),
    `barrel ${b0?.d.toFixed(0)} m, tell ${tellDist === null ? '—' : tellDist.toFixed(0)} m, sparkle opacity ${tell?.opacity ?? '—'}`);
}

// ══ (i) OWN-SHIP IDENTITY FROM THE WATER ═════════════════════════════════════
if (phase('i')) {
  say('\n(i) your own hull, seen from under 50 m');
  const shipPos = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const s = g.state.ships.find((x) => x.id === me?.shipId);
    const other = g.state.ships.find((x) => x.id !== me?.shipId && x.alive);
    return s ? {
      x: s.position.x, y: s.position.y, z: s.position.z, rot: s.rotation,
      other: other ? { x: other.position.x, y: other.position.y, z: other.position.z } : null,
    } : null;
  });
  if (shipPos) {
    // Off her beam at 34 m — inside the 50 m the identity is supposed to hold at.
    const bx = Math.cos(shipPos.rot), bz = -Math.sin(shipPos.rot);
    await look([shipPos.x + bx * 34, shipPos.y + 9, shipPos.z + bz * 34], [shipPos.x, shipPos.y + 5, shipPos.z]);
    await wait(SETTLE);
    shots['i-own-ship-34m'] = await capture('i-own-ship-34m');
    const card = await page.evaluate(() => (document.getElementById('ship-card-title')?.textContent
      ?? document.querySelector('#ship-card .card-title')?.textContent ?? '').replace(/\s+/g, ' ').trim());
    say(`  hull card: "${card}"`);
    ok('the hull card names her as YOURS while she is in shot', /YOUR/i.test(card), card);
  } else {
    ok('there is an own ship to photograph', false, 'no ship for the local player');
  }
}

// ══ (e) + (n) SAIL OUT THROUGH THE RING ══════════════════════════════════════
if (phase('e') || phase('n')) {
  say('\n(e/n) take the wheel, sail out through the wall');
  await page.evaluate(() => window.__piratesBR.disableFreeCam());
  await wait(600);
  // Aboard and at the wheel. Ported from endgame-live-smoke's takeTheHelm, which
  // is the version that actually works: the berth sometimes lands her on the pier
  // rather than the deck, the wheel has to be WALKED to in ship-local coordinates,
  // and [X] is a real keydown/keyup pair because the HUD's interact gate reads
  // document events, not a method call.
  let s = await snap();
  const pressX = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 70);
    });
    await wait(280);
  };
  const helmZ = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((x) => x.id === me?.shipId);
    const L = { sloop: 12, brigantine: 16, galleon: 22 }[ship?.type] ?? 12;
    return -L * 0.37;
  });
  for (let i = 0; i < 90 && !s.onShip && left() > 200_000; i++) {
    await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      if (!sh) return;
      const st = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[sh.type] ?? { w: 5, l: 12 };
      const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
      let best = null;
      for (const lx of [st.w * 0.56, -st.w * 0.56]) {
        const lz = -st.l * 0.18;
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
    if (/Climb|Aboard|Board/i.test(prompt)) await pressX();
    s = await snap();
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  say(`  aboard: ${s.onShip}`);
  for (let attempt = 0; attempt < 4 && !s.atHelm && left() > 180_000; attempt++) {
    for (let i = 0; i < 200; i++) {
      const d = await page.evaluate(([tz, stop]) => {
        const g = window.__piratesBR;
        const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
        const ship = g.state.ships.find((sh) => sh.id === me?.shipId);
        if (!ship) return 999;
        const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
        const wx = ship.position.x + tz * sin, wz = ship.position.z + tz * cos;
        const dx = wx - me.position.x, dz = wz - me.position.z;
        g.input.setLook(Math.atan2(dx, dz), -0.3);
        if (Math.hypot(dx, dz) > stop) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
        return Math.hypot(dx, dz);
      }, [helmZ + 1.0, 0.28]);
      if (d < 0.28) break;
      await wait(90);
    }
    await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
    await page.evaluate(([tz]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const ship = g.state.ships.find((sh) => sh.id === me?.shipId);
      const h = { sloop: 1.5, brigantine: 1.8, galleon: 2.2 }[ship.type] ?? 1.5;
      const wx = ship.position.x + tz * Math.sin(ship.rotation), wz = ship.position.z + tz * Math.cos(ship.rotation);
      const wy = ship.position.y + h + 0.95;
      const dx = wx - me.position.x, dz = wz - me.position.z;
      const eyeY = me.position.y + 1.8 * 0.72;
      g.input.setLook(Math.atan2(dx, dz), Math.atan2(wy - eyeY, Math.hypot(dx, dz)));
    }, [helmZ]);
    await wait(320);
    for (let i = 0; i < 4 && !s.atHelm; i++) { await pressX(); s = await snap(); }
  }
  say(`  helm: ${JSON.stringify(s)}`);

  // ── (e) the readout and the velocity, on ONE painted frame ────────────────
  if (phase('e')) {
    // Get her moving first: a hull at rest reads "dead in the water", which is
    // true and proves nothing.
    await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const ship = g.state.ships.find((x) => x.id === me?.shipId);
      g.input.setLook((ship?.rotation ?? 0) + 1.1, 0);
      g.input.keys.add('KeyW');
    });
    const reads = [];
    for (let i = 0; i < 20 && left() > 200_000; i++) {
      await wait(1500);
      const r = await page.evaluate(() => {
        const g = window.__piratesBR;
        // PAINT, THEN READ. updateHud writes the panel off the state that is live
        // right now; reading the DOM without forcing that pass reads whatever the
        // last throttled tick left there, which is one tick of lag and looks
        // exactly like a fabricated number.
        g.hud.updateHud();
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        const sh = g.state.ships.find((x) => x.id === me?.shipId);
        const panel = (document.getElementById('sail-status')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const kn = /making ([\d.]+) kn/.exec(panel);
        const card = (document.getElementById('ship-card')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return {
          speed: +Math.hypot(sh?.velocity.x ?? 0, sh?.velocity.z ?? 0).toFixed(3),
          knots: kn ? +kn[1] : null, anchored: !!sh?.anchored, panel, card,
        };
      });
      reads.push(r);
      if (r.knots !== null && r.speed > 1.2) break;
    }
    const best = reads.filter((r) => r.knots !== null).sort((a, b) => b.speed - a.speed)[0] ?? null;
    say(`  helm reads: ${JSON.stringify(reads.slice(-3))}`);
    ok('the helm quotes a speed measured off her own velocity, on the same frame',
      !!best && Math.abs(best.knots - best.speed * 1.94384) < 0.25,
      best ? `panel ${best.knots} kn vs velocity ${best.speed} u/s (×1.94384 = ${(best.speed * 1.94384).toFixed(2)})` : 'never got a knots reading under way');
    ok('and nothing on the ship card advertises a TOP SPEED it cannot make',
      !!best && !/TOP SPEED/i.test(best.card), best ? best.card.slice(0, 140) : '');
  }

  // ── (n) rain only under a closed deck ─────────────────────────────────────
  if (phase('n')) {
    say('  sailing OUT of the ring — the sky is photographed on the way');
    // A clear-weather control frame first: inside the ring, blue sky, and the
    // client must be drawing no rain at all.
    await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      g.input.setLook(g.state.ships.find((x) => x.id === me?.shipId)?.rotation ?? 0, 0.42);
    });
    await wait(SETTLE);
    const dry = await capture('n-inside-ring-blue-sky', [0.05, 0.02, 0.95, 0.34]);
    const dryState = await snap();
    shots['n-inside-ring-blue-sky'] = dry;
    say(`  control frame: ${JSON.stringify(dryState)}`);

    // Now steer for the wall: the outward bearing from the ring centre, hard over.
    let wet = null, wetState = null;
    for (let i = 0; i < 200 && left() > 90_000; i++) {
      await page.evaluate(() => {
        const g = window.__piratesBR;
        const me = g.state.players.find((p) => p.id === g.localPlayerId);
        const sh = g.state.ships.find((x) => x.id === me?.shipId);
        const st = g.state.storm;
        // Outward from the ring centre — the shortest way to weather.
        const want = Math.atan2(sh.position.x - st.centerX, sh.position.z - st.centerZ);
        const d = Math.atan2(Math.sin(want - sh.rotation), Math.cos(want - sh.rotation));
        g.input.keys.delete('KeyA'); g.input.keys.delete('KeyD');
        if (d > 0.08) g.input.keys.add('KeyD'); else if (d < -0.08) g.input.keys.add('KeyA');
        g.input.keys.add('KeyW');
        g.input.setLook(want, 0.42);
      });
      await wait(1400);
      s = await snap();
      if (i % 8 === 0) say(`    t=${s.t} d=${s.playerD}/${s.safe} (${s.outside}) speed=${s.speed} hp=${s.hp}`);
      if (s.outside !== null && s.outside > 12) { wetState = s; break; }
      if (s.state !== 'alive') { say(`    died on the way out: ${JSON.stringify(s)}`); break; }
    }
    if (wetState) {
      await wait(2200);
      wet = await capture('n-outside-ring-storm-sky', [0.05, 0.02, 0.95, 0.34]);
      shots['n-outside-ring-storm-sky'] = wet;
      say(`  weather frame: ${JSON.stringify(wetState)}`);
      // The rain the CLIENT is drawing, counted off the scene rather than guessed
      // from the sky: how many drop segments are live right now.
      const drops = await page.evaluate(() => {
        let n = 0;
        window.__piratesBR.renderer.scene.traverse((o) => {
          if (/rain|drop/i.test(o.name ?? '') && o.visible) n++;
        });
        return n;
      });
      say(`  rain nodes visible: ${drops}`);
      ok('the sky over the rain is CLOSED — darker and less blue than the clear control',
        !!wet && wet.box.mean < dry.box.mean * 0.85 && wet.box.blueness < dry.box.blueness - 8,
        `clear mean=${dry.box.mean} blue=${dry.box.blueness} sat=${dry.box.sat} → storm mean=${wet.box.mean} blue=${wet.box.blueness} sat=${wet.box.sat}`);
      ok('and the clear frame it is compared against really was a blue sky',
        dry.box.blueness > 20 && dry.box.mean > 90,
        `blueness=${dry.box.blueness} mean=${dry.box.mean}`);
    } else {
      ok('she reached weather to photograph', false, `never got outside the ring: ${JSON.stringify(s)}`);
    }
    await page.evaluate(() => { const k = window.__piratesBR.input.keys; k.delete('KeyW'); k.delete('KeyA'); k.delete('KeyD'); });
  }
}

// ══ (n2) THE SAME CLAIM, WITHOUT TOUCHING THE SHIP ═══════════════════════════
// The sailing version of (n) kept photographing the inside of the hold: the
// boarding loop walks her below decks, and a dark frame taken under a deck beam
// says nothing about the sky. This one never moves her. It parks a camera at her
// own position, looks UP, and waits for the ring to come to her — which it does,
// because a spawn that is never sailed is a spawn the storm eventually reaches.
// Same claim, both directions: blue sky must be dry, rain must have a closed deck
// over it, and the rain is counted off the scene rather than inferred.
if (phase('n2')) {
  say('\n(n2) the sky over her own head, before and after the wall arrives');
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
  const skyOverHer = async (name) => {
    const at = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      // Eight metres above her and looking up: high enough to clear the deck and
      // the rig, close enough that the camera is in the same weather she is.
      g.enableFreeCam(me.position.x, me.position.y + 8, me.position.z, 0, 0.85);
      return { x: +me.position.x.toFixed(1), z: +me.position.z.toFixed(1) };
    });
    await wait(SETTLE + 900);
    const st = await capture(name, [0.05, 0.02, 0.95, 0.45]);
    const live = await page.evaluate(() => {
      let drops = 0, splashes = 0;
      window.__piratesBR.renderer.scene.traverse((o) => {
        if (!o.visible) return;
        if (/rain/i.test(o.name ?? '')) drops++;
        if (/splash/i.test(o.name ?? '')) splashes++;
      });
      return { drops, splashes };
    });
    const s2 = await snap();
    say(`    ${name}: at ${JSON.stringify(at)} rain=${JSON.stringify(live)} state=${JSON.stringify(s2)}`);
    return { ...st, live, state: s2 };
  };
  const dry = await skyOverHer('n2-sky-inside-ring');
  shots['n2-sky-inside-ring'] = dry;
  let wet = null;
  for (let i = 0; i < 60 && left() > 80_000; i++) {
    await wait(4000);
    const s2 = await snap();
    if (i % 4 === 0) say(`    waiting: t=${s2.t} d=${s2.playerD}/${s2.safe} (${s2.outside}) hp=${s2.hp}`);
    if (s2.outside !== null && s2.outside > 15) { wet = await skyOverHer('n2-sky-in-the-weather'); break; }
    if (s2.state !== 'alive') { say(`    she died before the frame: ${JSON.stringify(s2)}`); break; }
  }
  if (wet) {
    shots['n2-sky-in-the-weather'] = wet;
    ok('under a live replicated storm the sky over the rain is CLOSED and tinted',
      wet.box.mean < dry.box.mean * 0.9 || wet.box.blueness < dry.box.blueness - 10,
      `clear mean=${dry.box.mean} blue=${dry.box.blueness} sat=${dry.box.sat} → weather mean=${wet.box.mean} blue=${wet.box.blueness} sat=${wet.box.sat}`);
    ok('and the control frame it is measured against really was an open blue sky',
      dry.box.blueness > 15 && dry.box.mean > 80,
      `blueness=${dry.box.blueness} mean=${dry.box.mean}`);
    ok('no rain falls out of the blue sky, and rain is in the scene once it closes',
      dry.live.drops === 0 || wet.live.drops > dry.live.drops,
      `clear drops=${dry.live.drops} weather drops=${wet.live.drops}`);
  } else {
    ok('the ring reached her so the weather could be photographed', false,
      'ran out of budget with her still inside the ring');
  }
}

writeFileSync(`${OUT}/voyage-report.json`, JSON.stringify({ shots, results, errors: errors.slice(0, 20) }, null, 1));
console.log(`\nconsole errors: ${errors.length}${errors.length ? ` -> ${errors.slice(0, 4).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  x ${f.label} — ${f.detail}`); }
await browser.close();
closed = true;
process.exit(failed.length ? 1 : 0);
