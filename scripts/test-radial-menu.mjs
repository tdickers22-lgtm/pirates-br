#!/usr/bin/env node
// THE SHARED RADIAL (b1.4d; crossdevice-01, vm:creative:2). Logic, quick tier.
//
//  • angle -> slice: clockwise from 12 o'clock, slice 0 centred on the top,
//    10 slices of 36 deg; the hub dead zone selects nothing; a tap well off
//    the wheel selects nothing.
//  • gamepad stick: a deflection past 0.5 selects by angle (y DOWN, as the
//    Gamepad API reports it), a centred stick KEEPS the last selection.
//  • digits: Digit1..9 = slices 0..8, Digit0 = slice 9, Numpad the same, and
//    the rule agrees with WHEEL_SLOTS for every slot.
//  • SupplyWheel: hover + release takes the hovered slot once; a finger tap
//    takes the tapped wedge and closes; InputManager routes digits through the
//    radial (no second digit rule).
//  • The painted wheel in index.html agrees: every slice path's centroid angle
//    maps back to its own data-wheel-slot.
import { readFileSync } from 'node:fs';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const tryImport = async (path) => {
  try { return await import(path); } catch (err) { expect(`import ${path}`, false, String(err?.message ?? err).split('\n')[0]); return null; }
};

const R = await tryImport('../src/client/ui/RadialMenu.ts');
const SW = await tryImport('../src/client/ui/SupplyWheel.ts');
const { WHEEL_SLOTS } = await import('../src/shared/wheel.ts');

const deg = (d) => (d * Math.PI) / 180;
const at = (d, r = 1) => [Math.sin(deg(d)) * r, -Math.cos(deg(d)) * r]; // screen: y down

if (R) {
  console.log('\nAngle -> slice');
  const cfg = R.DEFAULT_RADIAL;
  expect('10 slices by default, hub dead zone 0.26 of the radius', cfg.slices === 10 && Math.abs(cfg.deadzone - 0.26) < 1e-9);
  const cases = [[0, 0], [17, 0], [19, 1], [36, 1], [90, 3], [180, 5], [270, 8], [342, 0], [340, 9], [324, 9], [-10, 0]];
  const got = cases.map(([d]) => { const [x, y] = at(d, 80); return R.sliceAtOffset(x, y, 100); });
  expect('clockwise from the top: 0,17,19,36,90,180,270,342,340,324,-10 deg -> 0,0,1,1,3,5,8,0,9,9,0',
    cases.every(([, want], i) => got[i] === want), `got ${got.join(',')}`);
  expect('right of the hub is slice 3 (not 7: no mirrored wheel)', R.sliceAtOffset(80, 0, 100) === 3);
  expect('below the hub is slice 5', R.sliceAtOffset(0, 80, 100) === 5);
  expect('inside the hub (r 0.2) selects nothing', R.sliceAtOffset(...at(90, 20), 100) === null);
  expect('just outside the hub (r 0.3) selects', R.sliceAtOffset(...at(90, 30), 100) === 3);
  expect('NaN / zero radius select nothing', R.sliceAtOffset(NaN, 1, 100) === null && R.sliceAtOffset(50, 0, 0) === null);
  expect('a tap at 1.1 radii still takes the wedge; at 1.5 radii it takes nothing',
    R.sliceAtTap(...at(180, 110), 100) === 5 && R.sliceAtTap(...at(180, 150), 100) === null);

  console.log('\nGamepad stick');
  const m = new R.RadialMenu();
  expect('a small deflection (0.3) selects nothing', m.stick(0.3, 0) === null);
  expect('full right selects slice 3', m.stick(1, 0) === 3);
  expect('stick springs back to centre: selection KEPT', m.stick(0.02, -0.01) === 3 && m.hover === 3);
  expect('full up-left (-0.7,-0.7) selects slice 9 (315 deg rounds to 9)', m.stick(-0.7071, -0.7071) === 9);
  expect('take() returns the selection once, then nothing', m.take() === 9 && m.take() === null);

  console.log('\nDigits');
  const digitOk = WHEEL_SLOTS.every((s) => R.sliceForDigit(s.digitCode, 10) === s.index);
  expect('Digit codes agree with WHEEL_SLOTS for all 10 slots', digitOk);
  expect('Digit1 -> 0, Digit9 -> 8, Digit0 -> 9, Numpad4 -> 3', R.sliceForDigit('Digit1', 10) === 0
    && R.sliceForDigit('Digit9', 10) === 8 && R.sliceForDigit('Digit0', 10) === 9 && R.sliceForDigit('Numpad4', 10) === 3);
  expect('a digit past the slice count and non-digits select nothing',
    R.sliceForDigit('Digit9', 8) === null && R.sliceForDigit('KeyQ', 10) === null && R.sliceForDigit('Digit', 10) === null);

  console.log('\nPointer hover');
  const p = new R.RadialMenu();
  p.pointer(...at(144, 60), 100);
  expect('mouse at 144 deg hovers slice 4', p.hover === 4);
  p.pointer(3, 3, 100);
  expect('mouse back on the hub clears the hover (release takes nothing)', p.hover === null && p.take() === null);
}

if (SW) {
  console.log('\nSupplyWheel (the supply wheel on the radial)');
  const box = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 200 }) };
  let open = true;
  const used = [];
  let closes = 0;
  const w = new SW.SupplyWheel(box, { isOpen: () => open, activate: (s) => used.push(s), close: () => { closes += 1; open = false; } });
  const cx = 200; const cy = 150; // hub; radius 100 px
  w.pointerAt(cx + 70, cy); // slice 3
  expect('hover by angle: right of the hub = slice 3', w.hoverSlot === 3);
  w.update(); open = false; w.update(); w.update();
  expect('closing the wheel takes the hovered slot exactly once', used.length === 1 && used[0] === 3, `used ${used}`);
  open = true; w.update(); used.length = 0;
  const [tx, ty] = at(180, 75);
  const got = w.tapAt(cx + tx, cy + ty, true);
  w.update(); w.update();
  expect('a finger tap on the bottom wedge takes slot 5 and closes the wheel', got === 5 && used.join() === '5' && closes === 1 && !open,
    `got ${got} used ${used} closes ${closes}`);
  open = true; w.update(); used.length = 0;
  expect('a tap on the hub takes nothing and keeps the wheel open', w.tapAt(cx + 5, cy - 5, true) === null && used.length === 0 && open);
  expect('a mouse click takes the wedge but leaves the wheel to [I]', w.tapAt(cx - 70, cy, false) === 8 && open && used.join() === '8');
  used.length = 0;
  w.stick(0, -1);
  open = false; w.update();
  expect('pad: stick up then release takes slot 0', used.join() === '0', `used ${used}`);
  expect('stick while the wheel is closed selects nothing', w.stick(1, 0) === null);
}

console.log('\nOne digit rule and the painted wheel');
const im = readFileSync(new URL('../src/client/input/InputManager.ts', import.meta.url), 'utf8');
expect('InputManager picks wheel digits through RadialMenu.sliceForDigit', /sliceForDigit\(e\.code/.test(im) && !/wheelSlotForDigitCode\(/.test(im));
const game = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
expect('Game.ts has no private wheel-angle math left (atan2 over the wheel svg)', !/pocket-wheel-svg[\s\S]{0,600}Math\.atan2/.test(game) && /new SupplyWheel\(/.test(game));
if (R) {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const paths = [...html.matchAll(/data-wheel-slot="(\d)" d="M 0 0 L ([-\d.]+) ([-\d.]+) A 92 92 0 0 1 ([-\d.]+) ([-\d.]+) Z"/g)];
  const bad = paths.filter((p) => {
    const mx = (Number(p[2]) + Number(p[4])) / 2; const my = (Number(p[3]) + Number(p[5])) / 2;
    return R.sliceAtOffset(mx, my, 100) !== Number(p[1]);
  });
  expect(`all 10 painted slices map back to their own data-wheel-slot (${paths.length} paths)`, paths.length === 10 && bad.length === 0,
    bad.map((p) => p[1]).join(','));
}

console.log(failures ? `\nFAIL test-radial-menu (${failures})` : '\nPASS test-radial-menu');
process.exit(failures ? 1 : 0);
