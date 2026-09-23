#!/usr/bin/env node
/**
 * GAMEPAD CURVES, ROUTES, MENU NAV MATH AND HAPTICS (b1.4e; crossdevice-05/17).
 * Logic tier, quick (tsx, no DOM, no server).
 *
 *  1. radial deadzone 0.12 / outer 0.95 table (direction kept, rescaled 0..1);
 *  2. look curve exponent 2; full right stick for 1 s at sens 1 = 220 deg
 *     (3.84 rad, inside the 3.0-4.6 rad gate), pitch 150 deg/s, x sens x fovScale;
 *  3. routes come from the bindings table per context (helm LS = rudder + sails,
 *     cannon D-pad = ammo, wheel A = pick), reserved rows (ping/emote) unrouted;
 *  4. Y tap = reload, Y hold 400 ms = drop chest (never both); RT counts at half
 *     pull; a non-standard pad is ignored; a context switch releases held rows;
 *  5. MenuNav.pickNext walks a grid spatially;
 *  6. Haptics: each kind hands the pad / vibrate EXACTLY the table values; the
 *     mouse scheme does nothing; the disabled setting calls nothing at all.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
async function load(path) {
  try { return await import(path); } catch (err) { expect(`import ${path}`, false, String(err?.message ?? err).split('\n')[0]); return null; }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const G = await load('../src/client/input/GamepadSource.ts');
const H = await load('../src/client/input/Haptics.ts');
const N = await load('../src/client/input/MenuNav.ts');

if (G) {
  console.log('deadzone / curve table');
  const { radialDeadzone, lookCurve, lookStep, padRoutes, GamepadSource, HOLD_MS } = G;
  const table = [
    [[0.1, 0], 0], [[0.12, 0], 0], [[0, -0.119], 0], [[0.535, 0], 0.5], [[0.95, 0], 1], [[1, 0], 1], [[0.3, 0.4], (0.5 - 0.12) / 0.83],
  ];
  for (const [[x, y], want] of table) {
    const d = radialDeadzone(x, y);
    expect(`deadzone (${x}, ${y}) -> ${want.toFixed(3)}`, near(d.mag, want, 1e-4), `got ${d.mag.toFixed(4)}`);
  }
  const diag = radialDeadzone(0.7, 0.7);
  expect('a worn diagonal (0.7, 0.7) reaches full scale and keeps 45 deg', near(diag.mag, 1, 1e-9) && near(diag.x, diag.y, 1e-9) && near(diag.x, Math.SQRT1_2, 1e-9), JSON.stringify(diag));
  const half = lookCurve(0.535, 0);
  expect('look curve exponent 2: half the live band gives a quarter rate', near(half.x, 0.25, 1e-4), `got ${half.x.toFixed(4)}`);
  const full = lookStep(1, 0, 1);
  expect('full right stick 1 s at sens 1 turns 220 deg (3.84 rad, gate 3.0-4.6)', near(full.dx, 220 * Math.PI / 180, 1e-9) && full.dx >= 3.0 && full.dx <= 4.6, `${full.dx.toFixed(3)} rad`);
  const pitch = lookStep(0, -1, 1);
  expect('full stick up 1 s pitches 150 deg (dy < 0 = up, the Gamepad API y is down)', near(pitch.dy, -150 * Math.PI / 180, 1e-9), `${pitch.dy.toFixed(3)} rad`);
  expect('sensitivity 2 doubles and fovScale 0.25 quarters the rate', near(lookStep(1, 0, 1, 2, 0.25).dx, full.dx * 0.5, 1e-9));

  console.log('routes from the bindings table');
  const names = (route) => route ? [...route.tap, ...route.hold.map((a) => `${a}(hold)`)].sort().join(',') : '';
  const foot = padRoutes('foot');
  const want = { A: 'jump', B: 'crouch', X: 'interact', Y: 'dropChest(hold),reload', RT: 'fire', LT: 'aim', RB: 'weaponNext', DRight: 'weaponNext', DLeft: 'weaponPrev', LB: 'supplyWheel', LS: 'keg', RS: 'special', View: 'map', Menu: 'pause' };
  const footBad = Object.entries(want).filter(([b, w]) => names(foot.buttons.get(b)) !== w).map(([b, w]) => `${b}: want ${w} got ${names(foot.buttons.get(b))}`);
  expect('foot: A jump, B crouch, X interact, Y reload / hold drop chest, RT fire, LT aim, RB+D-right next, D-left prev, LB wheel, LS keg, RS special, View map, Menu pause', footBad.length === 0, footBad.join('; '));
  expect('foot: reserved ping (D-up) and emote (D-down) are not routed yet', !foot.buttons.has('DUp') && !foot.buttons.has('DDown'));
  expect('foot: LS up/down/left/right = the four move rows, RS = look', foot.stick.get('up')?.join() === 'moveForward' && foot.stick.get('left')?.join() === 'moveLeft' && foot.lookOnRS);
  const helm = padRoutes('helm');
  expect('helm: LS left/right = steerLeft/steerRight, up/down = sailsOut/sailsIn', helm.stick.get('left')?.join() === 'steerLeft' && helm.stick.get('right')?.join() === 'steerRight' && helm.stick.get('up')?.join() === 'sailsOut' && helm.stick.get('down')?.join() === 'sailsIn',
    JSON.stringify(Object.fromEntries(helm.stick)));
  expect('helm: D-pad left/right trim the sails, X leaves', names(helm.buttons.get('DLeft')) === 'trimLeft' && names(helm.buttons.get('DRight')) === 'trimRight' && names(helm.buttons.get('X')) === 'interact');
  const cannon = padRoutes('cannon');
  expect('cannon: RT fire, D-left round, D-right firebomb, Y chainshot', names(cannon.buttons.get('RT')) === 'fire' && names(cannon.buttons.get('DLeft')) === 'ammoRound' && names(cannon.buttons.get('DRight')) === 'ammoFire' && names(cannon.buttons.get('Y')) === 'ammoChain');
  const swim = padRoutes('swim');
  expect('swim: A up, B down', names(swim.buttons.get('A')) === 'jump' && names(swim.buttons.get('B')) === 'swimDown');
  const wheel = padRoutes('wheel');
  expect('wheel: A takes the pick, RB flips the page, no move rows', names(wheel.buttons.get('A')) === 'wheelPick' && names(wheel.buttons.get('RB')) === 'wheelPage' && wheel.stick.size === 0 && !wheel.lookOnRS);

  console.log('the source on a fake pad');
  let t = 0;
  const log = [];
  let look = 0;
  let noted = 0;
  const sink = { setActionHeld: (a, h) => log.push(`${a}:${h ? 'down' : 'up'}`), applyPadLook: (dx) => { look += dx; }, notePad: () => { noted += 1; } };
  const src = new GamepadSource(sink, () => t);
  const pad = () => ({ mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
  const p = pad();
  src.setContext('foot');
  p.axes[2] = 1;
  for (let i = 0; i < 60; i += 1) { t += 1000 / 60; src.poll(p, 1 / 60); }
  expect('60 frames of full right stick at 1/60 s turn 3.0-4.6 rad', look >= 3.0 && look <= 4.6 && noted > 0, `${look.toFixed(3)} rad`);
  p.axes[2] = 0;
  log.length = 0;
  p.buttons[3].pressed = true; src.poll(p, 0.016); t += 150; src.poll(p, 0.016);
  p.buttons[3].pressed = false; src.poll(p, 0.016);
  expect('Y tap (150 ms) = one reload press+release, no drop chest', log.join() === 'reload:down,reload:up', log.join());
  log.length = 0;
  p.buttons[3].pressed = true; src.poll(p, 0.016); t += HOLD_MS + 50; src.poll(p, 0.016);
  const midHold = log.join();
  p.buttons[3].pressed = false; src.poll(p, 0.016);
  expect('Y held 450 ms = drop chest only (pressed at 400 ms, released on lift), no reload', midHold === 'dropChest:down' && log.join() === 'dropChest:down,dropChest:up', log.join());
  log.length = 0;
  p.buttons[7].value = 0.6; src.poll(p, 0.016);
  expect('RT at 60% pull presses fire (analogue trigger, pressed flag false)', log.join() === 'fire:down', log.join());
  p.buttons[7].value = 0; src.poll(p, 0.016);
  log.length = 0;
  p.axes[1] = -1; src.poll(p, 0.016);
  expect('LS up on foot holds moveForward', src.isHeld('moveForward') && log.join() === 'moveForward:down', log.join());
  src.setContext('helm');
  expect('switching to the helm releases moveForward before sails can see it', !src.isHeld('moveForward') && log.includes('moveForward:up'), log.join());
  src.poll(p, 0.016);
  expect('LS up at the helm holds sailsOut', src.isHeld('sailsOut'));
  p.axes[1] = 0; p.axes[0] = 0.1; src.poll(p, 0.016);
  expect('a stick inside the 0.12 deadzone holds nothing', !src.isHeld('sailsOut') && !src.isHeld('steerRight'));
  expect('a pad without the standard mapping is ignored', GamepadSource.pick([{ ...pad(), mapping: '' }, null]) === null && GamepadSource.pick([null, pad()]) !== null);
}

if (N) {
  console.log('menu nav (pure)');
  const { pickNext } = N;
  const grid = [{ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 60, w: 100, h: 40 }, { x: 140, y: 0, w: 100, h: 40 }, { x: 140, y: 120, w: 100, h: 40 }];
  expect('down from the first button lands on the one below it', pickNext(grid[0], grid, 'down') === 1);
  expect('right from the first button lands beside it, not the far diagonal', pickNext(grid[0], grid, 'right') === 2);
  expect('up from the top row finds nothing', pickNext(grid[0], grid, 'up') === -1);
}

if (H) {
  console.log('haptics');
  const { Haptics, HAPTIC_TABLE } = H;
  const effects = [];
  const vib = [];
  let scheme = 'gamepad';
  const ports = { pad: () => ({ vibrationActuator: { playEffect: (type, params) => { effects.push({ type, ...params }); return Promise.resolve('complete'); } } }), vibrate: (ms) => { vib.push(ms); return true; }, scheme: () => scheme };
  const h = new Haptics(ports, true);
  const kinds = Object.keys(HAPTIC_TABLE);
  for (const k of kinds) h.pulse(k);
  const padOk = kinds.every((k, i) => effects[i]?.type === 'dual-rumble' && effects[i].duration === HAPTIC_TABLE[k].ms && effects[i].strongMagnitude === HAPTIC_TABLE[k].strong && effects[i].weakMagnitude === HAPTIC_TABLE[k].weak);
  expect(`pad: ${kinds.length} kinds rumble with exactly the table values`, padOk && vib.length === 0, JSON.stringify(effects));
  expect('table: fire 12 ms, hit 30 ms, breach 60 ms, cannon 40 ms at 0.6 strong', HAPTIC_TABLE.fire.ms === 12 && HAPTIC_TABLE.hitTaken.ms === 30 && HAPTIC_TABLE.breach.ms === 60 && HAPTIC_TABLE.cannonFire.ms === 40 && HAPTIC_TABLE.cannonFire.strong === 0.6);
  scheme = 'touch';
  for (const k of kinds) h.pulse(k);
  expect('touch: navigator.vibrate gets each kind\'s ms', vib.join() === kinds.map((k) => HAPTIC_TABLE[k].ms).join(), vib.join());
  scheme = 'mouse';
  const before = effects.length + vib.length;
  expect('mouse scheme: nothing rumbles', h.pulse('fire') === null && effects.length + vib.length === before);
  const off = new Haptics(ports, false);
  let touched = 0;
  const spyPorts = { pad: () => { touched += 1; return ports.pad(); }, vibrate: (ms) => { touched += 1; return ports.vibrate(ms); }, scheme: () => { touched += 1; return 'gamepad'; } };
  const offSpy = new Haptics(spyPorts, false);
  for (const k of kinds) { off.pulse(k); offSpy.pulse(k); }
  expect('disabled setting: every pulse is a no-op and no port is even read', effects.length + vib.length === before && touched === 0, `ports read ${touched}x`);
}

console.log('wiring (source)');
const im = readFileSync(new URL('../src/client/input/InputManager.ts', import.meta.url), 'utf8');
const game = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
expect('InputManager polls GamepadSource and pulses haptics on a non-mouse fire press', /new GamepadSource\(/.test(im) && /navigator\.getGamepads\(\)/.test(im) && /haptics\.pulse\(/.test(im));
expect('Game feeds the pad right stick to the supply wheel and sets the play context', /supplyWheel\?\.stick\(padStick\.x, padStick\.y\)/.test(game) && /input\.setPlayContext\(/.test(game));

if (failures) { console.error(`FAIL test-gamepad-curves (${failures})`); process.exit(1); }
console.log('PASS test-gamepad-curves');
