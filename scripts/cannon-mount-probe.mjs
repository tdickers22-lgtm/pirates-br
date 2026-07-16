// Reproduces the "use cannon puts me in the water" report: walks aboard the
// own ship, looks at a broadside cannon, presses [X] when the prompt reads
// cannon, then reports atCannon/state/position + screenshots.
// node scripts/cannon-mount-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'test-results/cannon-mount';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 30_000 });
const wait = (ms) => page.waitForTimeout(ms);

await page.goto('http://127.0.0.1:3000/?debug&forceinput', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 20_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30_000 });
await wait(3000);

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  return {
    me: { x: me.position.x, y: me.position.y, z: me.position.z, state: me.state, onShipId: me.onShipId, atCannon: me.atCannon },
    ship: ship ? { x: ship.position.x, y: ship.position.y, z: ship.position.z, rot: ship.rotation, type: ship.type } : null,
    prompt: document.getElementById('interact-prompt')?.textContent ?? '',
    kind: g.visibleInteractKind ?? null,
  };
});

// Steer helper: walk toward a world point until close.
async function walkTo(tx, tz, timeoutMs = 15000, closeEnough = 1.4) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await page.evaluate(([x, z]) => {
      const g = window.__piratesBR;
      const me = g.state.players.find((p) => p.id === g.localPlayerId);
      const dx = x - me.position.x;
      const dz = z - me.position.z;
      const yaw = Math.atan2(dx, dz);
      g.input.setLook(yaw, -0.05);
      g.input.keys.add('KeyW');
      return Math.hypot(dx, dz);
    }, [tx, tz]);
    if (d < closeEnough) break;
    await wait(120);
  }
  await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
}

// 1. Board the own ship: walk at it (falling in the gap is fine), then
// loop-press [X] whenever the resolved kind is board/dock until aboard.
let s = await snap();
console.log('spawn:', JSON.stringify(s.me), 'ship:', JSON.stringify(s.ship));
// Walk down the dock toward the ship and JUMP the ~1m rail gap.
for (let tries = 0; tries < 30; tries++) {
  s = await snap();
  if (s.me.onShipId) break;
  await page.evaluate(([sx, sz]) => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const yaw = Math.atan2(sx - me.position.x, sz - me.position.z);
    g.input.setLook(yaw, 0.05);
    g.input.keys.add('KeyW');
    g.input.jumpPressed = true;
    // If we fell in the water, spam [X] toward the hull for the boarding ladder.
    if (me.state === 'swimming') g.input.interactPressed = true;
  }, [s.ship.x, s.ship.z]);
  await wait(300);
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
s = await snap();
console.log('after boarding attempts:', JSON.stringify(s.me));

// 2. Walk to the starboard cannon deck spot (local x=+w/2-0.65, z=0.2L).
const cannonWorld = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((sh) => sh.id === me.shipId);
  const stats = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[ship.type];
  const lx = stats.w * 0.5 - 0.65, lz = stats.l * 0.2;
  const cos = Math.cos(ship.rotation), sin = Math.sin(ship.rotation);
  return { x: ship.position.x + lx * cos + lz * sin, z: ship.position.z + lz * cos - lx * sin };
});
await walkTo(cannonWorld.x, cannonWorld.z, 15000, 1.2);
await wait(400);

// 3. Look at the cannon (slightly outboard) until the prompt reads cannon.
await page.evaluate(([tx, tz]) => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const yaw = Math.atan2(tx - me.position.x, tz - me.position.z);
  g.input.setLook(yaw, -0.25);
}, [cannonWorld.x, cannonWorld.z]);
await wait(600);
s = await snap();
console.log('before press:', JSON.stringify(s));
await shot('1-before-press');

// 4. Press X ONLY when the resolved kind is cannon (mirror a real player
// pressing while the prompt shows Use Cannon).
for (let tries = 0; tries < 20; tries++) {
  s = await snap();
  if (s.me.atCannon) break;
  const pressed = await page.evaluate(() => {
    const g = window.__piratesBR;
    if (g.resolveCurrentInteractKind() !== 'cannon') return false;
    g.input.interactPressed = true;
    return true;
  });
  console.log(`try ${tries}: kind=${s.kind} prompt="${s.prompt}" pressed=${pressed} me=${JSON.stringify(s.me)}`);
  await wait(350);
}
s = await snap();
console.log('final:', JSON.stringify(s));
await shot('2-after-press');

await browser.close();
