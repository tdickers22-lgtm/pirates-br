#!/usr/bin/env node
// THE KEYBOARD TELLS THE TRUTH, AND LETS GO WHEN YOU DO.
//
// Three defects, one file, because they are all "what the keys actually do":
//  • hud-01/02 — four hand-written copies of the supply-wheel layout. The strip
//    advertised "1 Plantain | 2 Plank | 3 Coconut | 4 Meat" while those digits
//    took the spyglass, the compass, the bucket and a plank; the tenth slice
//    (the axe) had no key at all. One table (src/shared/wheel.ts) now feeds the
//    digits, the strip and the slice labels.
//  • hud-03 — the browser does not deliver a keyup for a key released while the
//    window is unfocused, so Cmd-Tab at the helm with [W] held kept sending
//    forward and sailed the sloop into the storm.
//  • hud-27 — the wheel re-routed only [Q] and Digit1-4, so [F] still braced the
//    yard and [X] fired an interact from under the overlay.
//
// No DOM, no stack: a minimal document/window stub records the listeners the
// InputManager registers and we dispatch synthetic events at it.
import { readFileSync } from 'node:fs';
import { InputManager } from '../src/client/input/InputManager.ts';
import { WHEEL_SLOTS, WHEEL_KEY_HINT, wheelSlotForDigitCode, wheelSlotForTool } from '../src/shared/wheel.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── The stub: just enough of a browser to run InputManager.init ────────────
function makeDom() {
  const listeners = new Map();
  const add = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const fire = (type, event = {}) => {
    for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
  };
  const body = { addEventListener: add, requestPointerLock: () => Promise.resolve() };
  globalThis.document = {
    body,
    activeElement: null,
    pointerLockElement: null,
    visibilityState: 'visible',
    exitPointerLock: () => {},
    addEventListener: add,
  };
  globalThis.window = { addEventListener: add, location: { search: '' } };
  return { body, fire };
}

const { body, fire } = makeDom();
const input = new InputManager();
input.init(body);
const down = (code) => fire('keydown', { code });
const up = (code) => fire('keyup', { code });

// ── One table, four consumers ──────────────────────────────────────────────
console.log('\nSupply wheel: one table drives the digits, the strip and the labels');
expect(`ten slices, ten keys (hint "${WHEEL_KEY_HINT}")`,
  WHEEL_SLOTS.length === 10 && new Set(WHEEL_SLOTS.map((s) => s.key)).size === 10);
for (const slot of WHEEL_SLOTS) {
  expect(`key ${slot.key} → slice ${slot.index} (${slot.label})`,
    wheelSlotForDigitCode(slot.digitCode) === slot.index,
    `got ${wheelSlotForDigitCode(slot.digitCode)}`);
}
expect('the axe has a key (slot 9 ← Digit0)',
  wheelSlotForDigitCode('Digit0') === 9 && WHEEL_SLOTS[9].tool === 'axe');
for (const slot of WHEEL_SLOTS.filter((s) => s.tool)) {
  expect(`${slot.tool} highlights slice ${slot.index}`, wheelSlotForTool(slot.tool) === slot.index);
}

// The digit the player presses IS the slice the packet carries.
console.log('\nDigits under the held wheel');
for (const slot of WHEEL_SLOTS) {
  down('KeyI');
  down(slot.digitCode);
  const packet = input.buildInput();
  up(slot.digitCode);
  up('KeyI');
  expect(`[I] + ${slot.key} sends wheelIndex ${slot.index} (${slot.label})`,
    packet.wheelIndex === slot.index && packet.useWheelItem === true,
    `got wheelIndex ${packet.wheelIndex}`);
}

// The pocket strip that HudController builds, reproduced from the same table:
// the gate is that the strip's digit for a consumable equals the wheel's digit.
console.log('\nThe pocket strip names the key that works');
const pocketSlots = WHEEL_SLOTS.filter((s) => s.pocket !== null);
const strip = pocketSlots.map((slot, i) => `${i === 0 ? 'Pocket: ' : ''}${slot.key} ${slot.label} 0`).join(' | ');
for (const slot of pocketSlots) {
  const advertised = `${slot.key} ${slot.label}`;
  expect(`strip says "${advertised}" and ${slot.key} takes ${slot.label}`,
    strip.includes(advertised) && wheelSlotForDigitCode(`Digit${slot.key}`) === slot.index);
}

// …and the HUD must DERIVE it rather than keep a fifth hand-written copy.
const hudSource = readFileSync(new URL('../src/client/ui/HudController.ts', import.meta.url), 'utf8');
expect('HudController builds the pocket strip from WHEEL_SLOTS',
  hudSource.includes('WHEEL_SLOTS.filter'),
  'the strip is hand-written again — the digits will drift a second time');
expect('the old hand-written "1 Plantain | 2 Plank" strip is gone',
  !hudSource.includes("'1 ' : ''}Plantain"));

// ── The wheel is a modal layer ─────────────────────────────────────────────
console.log('\n[I] is a modal layer, not a set of per-key exceptions');
down('KeyI');
down('KeyF');
down('KeyX');
down('KeyT');
down('Digit5');
let masked = input.buildInput();
expect('[I] then F does not brace the yard', masked.sailRight === false);
expect('[I] then X does not interact', masked.interact === false && masked.interactHeld === false);
expect('[I] then T does not parley', masked.trade === false);
expect('[I] then 5 picks the wheel slice, not chainshot ammo',
  masked.cannonAmmo === null && masked.wheelIndex === 4, `ammo ${masked.cannonAmmo}, wheel ${masked.wheelIndex}`);
up('KeyI');
up('KeyF');
up('KeyX');
up('KeyT');
up('Digit5');
// …and the same keys work the instant the overlay is gone.
down('KeyF');
const live = input.buildInput();
expect('F trims the yard again once [I] is released', live.sailRight === true);
up('KeyF');

// ── Hands off the keyboard ─────────────────────────────────────────────────
console.log('\nBlur, tab-hide and lost pointer lock let go of every held key');
down('KeyW');
expect('W held → forward', input.buildInput().forward === true);
fire('blur');
expect('blur → forward false (no keyup was ever delivered)', input.buildInput().forward === false);
expect('and the zeroed packet is forced out', input.hasPendingActions() === true);

down('KeyA');
expect('A held → left', input.buildInput().left === true);
globalThis.document.visibilityState = 'hidden';
fire('visibilitychange');
globalThis.document.visibilityState = 'visible';
expect('tab hidden → left false', input.buildInput().left === false);

down('KeyD');
expect('D held → right', input.buildInput().right === true);
globalThis.document.pointerLockElement = null;
fire('pointerlockchange');
expect('pointer lock lost → right false', input.buildInput().right === false);

// ── The printed card must agree with the code (hud-15, hud-01, hud-13) ──────
// The legend is the ONLY place a player is told what a key does, and it had
// drifted from the bindings it documents: it advertised "1–9" for a wheel whose
// ninth and tenth slices need Digit9 and Digit0, and "T · Trade" for a layer the
// supply wheel replaced (hud-15 — T leaves the default layer; trade returns as a
// contextual rail prompt with CREW-01). It also promises a refusal the player
// can SEE: HudController stamps .refused on #interact-prompt, and index.html
// must own the keyframes or that class paints nothing (hud-11).
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const legendBlocks = html.split('\n').filter((l) => /·\s*(Spyglass|Special|Supply [Ww]heel|Trade)/.test(l));
expect('the controls legend was found in index.html', legendBlocks.length >= 3, `blocks=${legendBlocks.length}`);
expect('no "Trade" key is advertised in the legend (hud-15)',
  legendBlocks.every((l) => !/Trade/.test(l)),
  legendBlocks.filter((l) => /Trade/.test(l)).map((l) => l.trim()).join('\n     '));
const wheelLines = legendBlocks.filter((l) => /Supply [Ww]heel/.test(l));
expect('the supply-wheel legend prints the key range the table actually binds',
  wheelLines.length > 0 && wheelLines.every((l) => l.includes(WHEEL_KEY_HINT)),
  `WHEEL_KEY_HINT=${WHEEL_KEY_HINT} · ${wheelLines.map((l) => l.trim()).join(' | ')}`);
expect('a refused prompt has an animation to run',
  /@keyframes\s+refuse-shake/.test(html) && /#interact-prompt\.refused/.test(html));

console.log(failures === 0 ? '\nPASS wheel + input layer' : `\nFAIL wheel + input layer (${failures})`);
process.exit(failures === 0 ? 0 : 1);
