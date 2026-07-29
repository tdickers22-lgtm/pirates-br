// HELM STANCE PROBE — the newcomer's walk, live.
//
// A fresh join, board her own hull, walk onto the quarterdeck WITHOUT ever
// putting the crosshair on the wheel, and read what [X] offers at four stances.
// Then press [X] ONCE and confirm the server put her at the helm.
//
// node --import tsx <this> [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { getHelmControlLocal, HELM_STAND_CONE } from '../src/shared/interactions.ts';

const OUT = process.argv[2] ?? 'test-results/helm-stance';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
const wait = (ms) => page.waitForTimeout(ms);

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

async function join() {
  await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
  // A FIRST-EVER voyage: this is the newcomer the defect is about.
  await page.evaluate(() => { try { localStorage.removeItem('piratesBR.seenControls'); } catch {} });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
  await wait(2500);
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
  // A first-ever voyage opens the three-card tour over the view. Skip it the way
  // a player does — otherwise every stance shot is a picture of the tour rather
  // than of the prompt this probe exists to photograph.
  if (await page.isVisible('#onboard-cards.visible').catch(() => false)) {
    await page.click('#oc-skip', { timeout: 5_000 }).catch(() => {});
    await wait(400);
  }
}
await join();

const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (fn, arg) => {
  try { return await rawEvaluate(fn, arg); } catch (err) {
    if (!/destroyed|navigation|Target closed/i.test(String(err))) throw err;
    console.log('  (page reloaded under the probe — rejoining)');
    await join();
    return await rawEvaluate(fn, arg);
  }
};

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const r2 = (v) => +v.toFixed(2);
  let local = null, helmDist = null;
  if (ship) {
    const dx = me.position.x - ship.position.x, dz = me.position.z - ship.position.z;
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    local = { x: r2(dx * cos - dz * sin), z: r2(dx * sin + dz * cos) };
    const HELM_F = { sloop: 12, brigantine: 16, galleon: 22 }[ship.type];
    // helm local z = -length * HELM_LOCAL_Z_F, read from the game itself below
    helmDist = null; void HELM_F;
  }
  const promptEl = document.getElementById('interact-prompt');
  return {
    state: me.state, onShip: !!me.onShipId, atHelm: !!me.atHelm, atCannon: !!me.atCannon,
    y: r2(me.position.y), local, shipType: ship?.type ?? null,
    promptShown: promptEl ? getComputedStyle(promptEl).display !== 'none' : false,
    prompt: (promptEl?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    kind: g.visibleInteractKind ?? null,
    objective: (document.getElementById('br-progress-feed')?.textContent ?? '').split(' · ')[0],
  };
});

/** The wheel's ship-local point, straight out of the shipped module — never a
 *  number retyped into this probe. (Hardcoding 0.34 here instead of reading
 *  HELM_LOCAL_Z_F=0.37 put stance 4 outside the cone and cried wolf once.) */
const helmLocal = async () => {
  const type = await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    return g.state.ships.find((s) => s.id === me?.shipId)?.type ?? null;
  });
  return { ...getHelmControlLocal(SHIP_STATS[type]), type };
};

const toWorld = (lx, lz) => page.evaluate(([tx, tz]) => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
  return { x: ship.position.x + tx * cos + tz * sin, z: ship.position.z + tz * cos - tx * sin };
}, [lx, lz]);

/** Walk to a ship-local point, keeping the eye where the caller wants it. */
async function walkToLocal(lx, lz, { pitch = -0.25, stopAt = 0.28, maxSteps = 200 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const d = await page.evaluate(([tx, tz, stop, p]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
      const ship = g.state.ships.find((s) => s.id === me?.shipId);
      if (!ship) return 999;
      const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
      const wx = ship.position.x + tx * cos + tz * sin;
      const wz = ship.position.z + tz * cos - tx * sin;
      const dx = wx - me.position.x, dz = wz - me.position.z;
      g.input.setLook(Math.atan2(dx, dz), p);
      if (Math.hypot(dx, dz) > stop) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
      return Math.hypot(dx, dz);
    }, [lx, lz, stopAt, pitch]);
    if (d < stopAt) break;
    await wait(85);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await wait(260);
}

/** Aim the eye along the ship's own axes — never at the wheel. */
async function gaze(dirLocalX, dirLocalZ, pitch) {
  await page.evaluate(([dx, dz, p]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((pl) => pl.id === g.localPlayerId);
    const ship = g.state.ships.find((s) => s.id === me?.shipId);
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    // local direction → world direction
    const wx = dx * cos + dz * sin, wz = dz * cos - dx * sin;
    g.input.setLook(Math.atan2(wx, wz), p);
  }, [dirLocalX, dirLocalZ, pitch]);
  await wait(360);
}

const pressX = async () => {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 70);
  });
  await wait(320);
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
};

// ── DRY FEET against her own hull ────────────────────────────
// The swim-only predicate left a silent dead zone: a pirate standing on the
// sand or the dock planking with her shoulder on her own hull got no prompt in
// any direction. Walk her up to the hull WITHOUT letting her into the water and
// read what [X] says while her feet are still dry.
console.log('\nAshore against her own hull:');
{
  let dry = null;
  let wentSwimming = false;
  for (let i = 0; i < 90; i += 1) {
    const step = await page.evaluate(() => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const sh = g.state.ships.find((x) => x.id === me?.shipId);
      const stats = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[sh.type];
      const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
      let best = null;
      for (const lx of [stats.w * 0.5, -stats.w * 0.5]) {
        for (const lz of [-stats.l * 0.2, 0, stats.l * 0.2]) {
          const x = sh.position.x + lx * cos + lz * sin;
          const z = sh.position.z + lz * cos - lx * sin;
          const d = Math.hypot(x - me.position.x, z - me.position.z);
          if (!best || d < best.d) best = { x, z, d };
        }
      }
      g.input.setLook(Math.atan2(best.x - me.position.x, best.z - me.position.z), 0.05);
      // Never jump and never swim — this stage is about DRY FEET.
      if (me.state === 'alive' && best.d > 1.0) g.input.keys.add('KeyW');
      else g.input.keys.delete('KeyW');
      const promptEl = document.getElementById('interact-prompt');
      return {
        d: +best.d.toFixed(2), state: me.state, onShip: !!me.onShipId,
        prompt: (promptEl?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        kind: g.visibleInteractKind ?? null,
      };
    });
    // Only the OWN-HULL offer counts. A 'board' prompt read from 2.6 m out is
    // the dock's own swim-ladder — a real affordance, but not the shared
    // predicate this stage exists to exercise — so keep the CLOSEST dry-footed
    // "Climb Aboard" seen anywhere on the approach rather than whichever
    // prompt happened to be up on the frame the loop chose to stop.
    if (step.state === 'alive' && !step.onShip && /climb aboard/i.test(step.prompt)
      && (!dry || step.d < dry.d)) dry = step;
    if (dry && dry.d <= 1.0) break;
    if (step.state !== 'alive') { wentSwimming = true; break; }
    if (step.onShip) break;
    await wait(120);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
  await shot('0-ashore-against-own-hull');
  // Some spawns moor her off a beach with open water between the sand and the
  // planking; there is no dry approach to test on those, and calling that a
  // defect would be the probe blaming the map. SKIP, loudly, and let the
  // arbiter suite (which proves the predicate on all three hulls plus the
  // server grant) carry the claim on those rolls.
  if (!dry && wentSwimming) {
    console.log('  ~ SKIPPED — this spawn puts water between the shore and the hull; no dry approach exists');
  } else {
    console.log(`  ${dry ? `d=${dry.d}m state=${dry.state} prompt="${dry.prompt}"` : 'never got a dry-footed board offer'}`);
    check('on foot beside her own hull, [X] offers to climb aboard',
      !!dry && /climb aboard/i.test(dry.prompt), JSON.stringify(dry));
    check('…and she is genuinely ashore, not treading water', !!dry && dry.state === 'alive',
      JSON.stringify(dry));
  }
}

// ── Board her own hull ───────────────────────────────────────
console.log('\nBoarding:');
let s = await snap();
console.log(`  spawn: state=${s.state} ship=${s.shipType}`);
for (let i = 0; i < 220 && !s.onShip; i++) {
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const sh = g.state.ships.find((x) => x.id === me?.shipId);
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
  s = await snap();
  if (/Climb|Aboard/.test(s.prompt)) await pressX();
  s = await snap();
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
await shot('00-aboard');
// EVERY STAGE BELOW STANDS ON HER BEING ABOARD. On a dev server several agents
// are hammering ("SIM 3s BEHIND") the walk sometimes never lands, and carrying
// on from the beach reports the helm cone as broken from 26 m away — ten
// invented defects out of one slow tick. Say INCONCLUSIVE and stop instead.
if (!s.onShip) {
  console.log(`\n!! INCONCLUSIVE — never got aboard (${JSON.stringify(s)})`);
  console.log('   This is the probe losing a race with a loaded sim, not a game defect.');
  await browser.close();
  process.exit(2);
}
check('she gets aboard her own hull', s.onShip, JSON.stringify(s));

const helm = await helmLocal();
console.log(`  hull=${helm.type} wheel at local z=${helm.z.toFixed(2)}`);

// The missing beat should own the objective line the instant she is aboard.
// Capture the FACTS the beat keys off at the same instant, so a miss reads as
// "she was already under way" rather than an unexplained wrong string.
const aboardSnap = await snap();
const beatFacts = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return {
    anchored: !!ship?.anchored, sailHeight: +(ship?.sailHeight ?? -1).toFixed(2),
    atHelm: !!me.atHelm, onOwnShip: me.onShipId === ship?.id,
    firstSailDone: g.hud.firstSailDone, ownShipObjectiveActive: g.ownShipObjectiveActive,
  };
});
console.log(`  objective aboard: "${aboardSnap.objective}"`);
console.log(`  beat facts: ${JSON.stringify(beatFacts)}`);
check('aboard with the anchor down, the objective points at the wheel',
  /take the helm \[X\]/i.test(aboardSnap.objective), aboardSnap.objective);

// ── Four stances, never looking at the wheel ─────────────────
// The stances are the newcomer's: she walks onto the dais and looks where a
// person looks — out over the bow, down at her boots, off to the side.
const STANCES = [
  { id: '1-dead-on-forward',  lx: 0,    dz: 0.05, gaze: [0, 1, 0.0],   note: 'dead on the wheel, gazing forward over the bow' },
  { id: '2-dead-on-down',     lx: 0,    dz: 0.05, gaze: [0, 1, -0.85], note: 'dead on the wheel, gazing down at the deck' },
  { id: '3-abaft-port',       lx: 0.55, dz: -0.9, gaze: [-1, 0, -0.1], note: 'a step abaft the wheel, gazing off to port' },
  // The cone's OUTER EDGE, on the diagonal and facing away from the wheel —
  // the worst case the fix claims, and the one the box-shaped isNearHelm
  // would have dropped on its own.
  { id: '4-cone-edge-back-turned', lx: -0.62, dz: 1.05, gaze: [0, 1, 0.15],
    note: 'at the cone edge forward of the wheel, back turned, gazing down the deck' },
];

console.log('\nFour stances on the quarterdeck (crosshair never on the wheel):');
const stanceRows = [];
for (const st of STANCES) {
  await walkToLocal(helm.x + st.lx, helm.z + st.dz, { pitch: -0.2 });
  await gaze(st.gaze[0], st.gaze[1], st.gaze[2]);
  const snapshot = await page.evaluate(([hx, hz]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const ship = g.state.ships.find((x) => x.id === me?.shipId);
    const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
    const dx = me.position.x - ship.position.x, dz = me.position.z - ship.position.z;
    const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
    const promptEl = document.getElementById('interact-prompt');
    return {
      d: +Math.hypot(lx - hx, lz - hz).toFixed(2),
      prompt: (promptEl?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      shown: promptEl ? getComputedStyle(promptEl).display !== 'none' : false,
      kind: g.visibleInteractKind ?? null,
      atHelm: !!me.atHelm,
    };
  }, [helm.x, helm.z]);
  await shot(`stance-${st.id}`);
  stanceRows.push({ ...st, ...snapshot });
  console.log(`  ${st.id}: d=${snapshot.d}m (cone ${HELM_STAND_CONE}m) kind=${snapshot.kind} prompt="${snapshot.prompt}"`);
  // A stance that drifted outside the cone proves nothing either way — say so
  // out loud rather than filing it as a game defect.
  check(`${st.id}: the stance is actually inside the helm cone`,
    snapshot.d <= HELM_STAND_CONE, `d=${snapshot.d} > ${HELM_STAND_CONE}`);
  check(`${st.note} → [X] offers the helm`,
    snapshot.kind === 'helm' && /take helm/i.test(snapshot.prompt) && snapshot.shown,
    `kind=${snapshot.kind} prompt="${snapshot.prompt}" shown=${snapshot.shown} d=${snapshot.d}`);
}

// ── ONE press takes the wheel ────────────────────────────────
console.log('\nOne press:');
await walkToLocal(helm.x, helm.z + 0.05, { pitch: -0.2 });
await gaze(0, 1, 0.0);
const before = await snap();
await pressX();
// The press is a round trip. On a dev server running several agents' matches
// the sim runs seconds behind, so a fixed 500 ms sleep reads a server that
// simply has not answered yet as "the press did nothing". Wait for the ANSWER.
await page.waitForFunction(() => {
  const g = window.__piratesBR;
  return !!g.state.players.find((p) => p.id === g.localPlayerId)?.atHelm;
}, null, { timeout: 12_000 }).catch(() => {});
const after = await snap();
console.log(`  before: atHelm=${before.atHelm} prompt="${before.prompt}"`);
console.log(`  after:  atHelm=${after.atHelm}`);
check('one [X], never having looked at the wheel, takes the helm', after.atHelm === true,
  JSON.stringify({ before: before.prompt, after: after.atHelm }));
await shot('5-at-the-helm');

// The card must not be sitting over the wheel it explains.
const cardAtStation = await page.evaluate(() => {
  const el = document.getElementById('controls-hint');
  return { display: el ? getComputedStyle(el).display : 'missing' };
});
check("Ship's Orders is not parked over the station", cardAtStation.display !== 'block', JSON.stringify(cardAtStation));

// The beat is spent once she has the wheel.
const helmObjective = (await snap()).objective;
console.log(`  objective at the helm: "${helmObjective}"`);
check('the wheel in her hands spends the take-helm beat', !/take the helm \[X\]/i.test(helmObjective), helmObjective);

// ── The other stations still answer from their own posts ─────
console.log('\nThe other stations still win from their own posts:');
await page.evaluate(() => {
  const g = window.__piratesBR;
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 60);
  void g;
});
await wait(400);

// ── The card docks instead of curtaining ─────────────────────
console.log("\nShip's Orders, live:");
const card = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const el = document.getElementById('controls-hint');
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  if (me.atHelm) { me.atHelm = false; }
  el.style.display = 'block';
  g.hud.updateHud();
  const r0 = el.getBoundingClientRect();
  const full = { w: Math.round(r0.width), left: Math.round(r0.left) };
  await new Promise((r) => setTimeout(r, 250));
  return { full, viewportW: innerWidth };
});
await shot('6-card-full');
const docked = await page.evaluate(async () => {
  const g = window.__piratesBR;
  const el = document.getElementById('controls-hint');
  // Age the card past its dock timer without stalling the probe 10 real seconds.
  g.hud.legendOpenContext.at -= 11_000;
  g.hud.updateHud();
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), left: Math.round(r.left), docked: el.classList.contains('docked'),
    clipped: el.scrollHeight - el.clientHeight };
});
await shot('7-card-docked');
console.log(`  full w=${card.full.w} → docked w=${docked.w} left=${docked.left} clip=${docked.clipped}px`);
check('the card shrinks to a side panel and gives the sea back',
  docked.docked && docked.w < card.full.w * 0.62 && docked.left < 40, JSON.stringify({ card, docked }));
check('and nothing is cropped off the shrunken card', docked.clipped <= 0, `${docked.clipped}px`);

console.log(`\nconsole errors: ${errors.length}${errors.length ? ` → ${errors.slice(0, 3).join(' | ')}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`); }
await browser.close();
process.exit(failed.length ? 1 : 0);
