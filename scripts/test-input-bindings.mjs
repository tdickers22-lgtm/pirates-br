#!/usr/bin/env node
// ONE BINDINGS TABLE, AN INPUT AUTHORITY THAT KNOWS ABOUT TOUCH AND PADS, A
// POINTER LOCK THAT NEVER THROWS, AND A CHART THAT ZOOMS LIKE A TRACKPAD (b1.4a).
//
//  • crossdevice-14 / mechanicshud-05: every action has a keyboard/mouse, a
//    Standard Gamepad and a touch binding (or an explicit n/a with a reason), and
//    no two actions whose contexts overlap share a token. V/MMB ping, T emote
//    and Tab scoreboard are reserved. InputManager and Game read the table, not
//    `code === 'KeyX'` literals, and the legend card still names every live key.
//  • crossdevice-02: touch/gamepad schemes fire and aim without pointer lock; the
//    mouse scheme still needs the lock (the first click only re-acquires it).
//  • crossdevice-11: requestPointerLock returning undefined never throws; the
//    first post-lock movement is dropped and each delta is clamped to 300 px.
//  • crossdevice-09: 40 x deltaY -4 -> 1.3-1.6x zoom, one notch -100 -> 1.2-1.3x,
//    10 x ctrl deltaY -10 (a macOS pinch) -> 2-3x; deltaX pans.
//
// No DOM, no stack: a minimal document/window stub runs the real InputManager.
import { readFileSync } from 'node:fs';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const tryImport = async (path) => {
  try { return await import(path); } catch (err) { expect(`import ${path}`, false, String(err?.message ?? err).split('\n')[0]); return null; }
};

const B = await tryImport('../src/shared/bindings.ts');
const AUTH = await tryImport('../src/client/input/inputAuthority.ts');
const LOCK = await tryImport('../src/client/input/pointerLock.ts');
const WHEEL = await tryImport('../src/client/input/wheelGesture.ts');

// ── The table ─────────────────────────────────────────────────────────────
console.log('\nThe bindings table');
if (B) {
  const { BINDINGS, BINDING_ACTIONS, validateBindings, isNotApplicable, tokensFor } = B;
  expect(`>= 35 actions (${BINDING_ACTIONS.length})`, BINDING_ACTIONS.length >= 35);
  const problems = validateBindings();
  expect('validateBindings(): every scheme bound or n/a with a reason, no shared token in an overlapping context',
    problems.length === 0, problems.join('\n     '));
  for (const scheme of ['keyboard', 'gamepad', 'touch']) {
    const missing = BINDING_ACTIONS.filter((a) => {
      const b = BINDINGS[a][scheme];
      return !(isNotApplicable(b) ? b.na.length >= 8 : b.length > 0);
    });
    expect(`every action has a ${scheme} binding or an n/a reason`, missing.length === 0, missing.join(', '));
  }
  // The validator itself can fail: plant a conflict, an empty row and a bare n/a.
  const planted = { ...BINDINGS, badReload: { ...BINDINGS.reload, keyboard: ['KeyX'] } };
  expect('a planted foot-context KeyX clash with interact is caught',
    validateBindings(planted).some((p) => p.includes('interact') && p.includes('KeyX')));
  const empty = { ...BINDINGS, reload: { ...BINDINGS.reload, touch: [] } };
  expect('an empty scheme binding is caught', validateBindings(empty).some((p) => p.startsWith('reload.touch')));
  const bare = { ...BINDINGS, reload: { ...BINDINGS.reload, gamepad: { na: '' } } };
  expect('an n/a without a reason is caught', validateBindings(bare).some((p) => p.startsWith('reload.gamepad')));
  const wheelOk = { ...BINDINGS, x: { ...BINDINGS.wheelPage, contexts: ['wheel'], keyboard: ['Digit1'] } };
  expect('a digit shared by the modal wheel and another wheel action is caught',
    validateBindings(wheelOk).some((p) => p.includes('Digit1')));
  // Reserved: V / middle mouse ping, T emote, Tab scoreboard (creative-01/04 verifier).
  expect('ping reserves V and middle mouse', ['KeyV', 'Mouse1'].every((t) => tokensFor('ping', 'mouse').includes(t)));
  expect('emote reserves T', tokensFor('emote', 'mouse').includes('KeyT'));
  expect('scoreboard reserves Tab', tokensFor('scoreboard', 'mouse').includes('Tab'));
  expect('ping/emote/scoreboard are marked reserved',
    ['ping', 'emote', 'scoreboard'].every((a) => typeof BINDINGS[a].reserved === 'string'));
  // Trackpad: nothing needs button 2 without an alternative (D2).
  const rmbOnly = BINDING_ACTIONS.filter((a) => {
    const t = tokensFor(a, 'mouse');
    return t.includes('Mouse2') && t.length === 1;
  });
  expect('no action needs the right button without an alternative', rmbOnly.length === 0, rmbOnly.join(', '));
  // Gamepad tokens are Standard Gamepad names.
  const padNames = new Set(Object.keys(B.PAD_BUTTON_INDEX));
  const badPad = BINDING_ACTIONS.flatMap((a) => tokensFor(a, 'gamepad')).filter((t) => {
    const m = /^Pad:([A-Za-z]+)(?:\.(up|down|left|right|click|hold))?$/.exec(t);
    return !m || !(padNames.has(m[1]) || m[1] === 'LS' || m[1] === 'RS');
  });
  expect('every gamepad token names a Standard Gamepad control', badPad.length === 0, badPad.join(', '));
}

// ── The table is the only source: no literal key checks left ───────────────
console.log('\nNo hand-written key checks in InputManager / Game');
const INPUT_SRC = readFileSync(new URL('../src/client/input/InputManager.ts', import.meta.url), 'utf8');
const GAME_SRC = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
for (const [name, src] of [['InputManager.ts', INPUT_SRC], ['Game.ts', GAME_SRC]]) {
  const hits = [...src.matchAll(/\.code === '([A-Za-z0-9]+)'/g)].map((m) => m[1]);
  expect(`${name}: 0 \`.code === '...'\` literals (${hits.length})`, hits.length === 0, hits.join(', '));
  const unsafe = src.match(/requestPointerLock\?\.\(\)\.catch/g) ?? [];
  expect(`${name}: no unguarded requestPointerLock?.().catch`, unsafe.length === 0);
}

// ── The legend still names every live key the table binds ──────────────────
// (Carries test-onboarding-ux's legend audit now that the codes live in the
// table instead of InputManager's source.)
if (B) {
  console.log('\nThe legend card against the table');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<div id="controls-hint">');
  const legend = html.slice(start, html.indexOf('legend-foot', start))
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const LEGEND_TOKENS = {
    KeyW: /WASD/, KeyA: /WASD/, KeyS: /WASD/, KeyD: /WASD/,
    ArrowUp: /arrow keys/i, ArrowDown: /arrow keys/i, ArrowLeft: /arrow keys/i, ArrowRight: /arrow keys/i,
    Space: /SPACE/i, KeyZ: /\bZ · /, KeyC: /\bC · /, KeyX: /\bX · /, KeyB: /\bB · /, KeyE: /\bE · /,
    KeyR: /\bR · /, KeyG: /\bG · /, KeyP: /\bP · /, KeyM: /\bM · /, KeyL: /\bL · /, KeyI: /Hold I · /,
    KeyQ: /Q\/F|Q flips/, KeyF: /Q\/F/, ShiftLeft: /SHIFT/, ShiftRight: /SHIFT/,
    Digit1: /1–4/, Digit2: /1–4/, Digit3: /1–4/, Digit4: /1–4/,
    Digit5: /5\/6\/7/, Digit6: /5\/6\/7/, Digit7: /5\/6\/7/,
    Digit8: /1-9/, Digit9: /1-9/, Digit0: /0 to take/, F8: /F8/, Escape: /Esc/i,
  };
  const codes = B.keyboardCodes();
  const unknown = codes.filter((c) => !(c in LEGEND_TOKENS));
  expect('every live keyboard code is known to this audit', unknown.length === 0, unknown.join(', '));
  const missing = codes.filter((c) => LEGEND_TOKENS[c] && !LEGEND_TOKENS[c].test(legend));
  expect(`the legend names every live key (${codes.length} codes)`, missing.length === 0, missing.join(', '));
}

// ── Input authority (pure) ────────────────────────────────────────────────
console.log('\nInput authority');
if (AUTH) {
  const { resolveInputAuthority: r, lockHintVisible: h } = AUTH;
  expect('mouse scheme, unlocked -> no authority', r({ pointerLocked: false, scheme: 'mouse' }) === false);
  expect('mouse scheme, locked -> authority', r({ pointerLocked: true, scheme: 'mouse' }) === true);
  expect('touch scheme, unlocked -> authority', r({ pointerLocked: false, scheme: 'touch' }) === true);
  expect('gamepad scheme, unlocked -> authority', r({ pointerLocked: false, scheme: 'gamepad' }) === true);
  expect('?forceinput -> authority', r({ pointerLocked: false, scheme: 'mouse', debugAssumeLocked: true }) === true);
  const base = { inMatch: true, menuVisible: false, pointerLocked: false };
  expect('lock pill shows for the mouse scheme when unlocked', h({ ...base, scheme: 'mouse' }) === true);
  expect('lock pill hidden for touch', h({ ...base, scheme: 'touch' }) === false);
  expect('lock pill hidden for gamepad', h({ ...base, scheme: 'gamepad' }) === false);
  expect('lock pill hidden when locked', h({ ...base, pointerLocked: true, scheme: 'mouse' }) === false);
}

// ── The real InputManager under a DOM stub ────────────────────────────────
function makeDom(requestPointerLock) {
  const listeners = new Map();
  const add = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const fire = (type, event = {}) => {
    for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
  };
  const body = { addEventListener: add, requestPointerLock };
  globalThis.document = {
    body, activeElement: null, pointerLockElement: null, visibilityState: 'visible',
    exitPointerLock: () => {}, addEventListener: add,
  };
  globalThis.window = { addEventListener: add, location: { search: '' } };
  return { body, fire };
}
console.log('\nInputManager: fire/aim per scheme, lock safety, look filter');
let IM = null;
try { IM = (await import('../src/client/input/InputManager.ts')).InputManager; } catch (err) { expect('import InputManager', false, String(err)); }
if (IM) {
  let lockCalls = 0;
  const { body, fire } = makeDom(() => { lockCalls += 1; return undefined; }); // WebKit: returns undefined
  const input = new IM();
  input.init(body);
  let threw = null;
  try { fire('mousedown', { button: 0 }); } catch (err) { threw = err; }
  expect('unlocked click with requestPointerLock() -> undefined does not throw', threw === null, String(threw));
  expect('...and it requested the lock', lockCalls >= 1);
  expect('mouse scheme, unlocked: the click did not fire', input.buildInput().fire === false);
  threw = null;
  try { fire('keydown', { code: 'KeyI' }); fire('keyup', { code: 'KeyI' }); } catch (err) { threw = err; }
  expect('closing the supply wheel with an undefined-returning lock does not throw', threw === null, String(threw));
  fire('keydown', { code: 'ShiftLeft' });
  expect('mouse scheme, unlocked: Shift does not aim', input.buildInput().aim === false);
  fire('keyup', { code: 'ShiftLeft' });

  // Touch scheme, no lock: fire and aim are honoured through the action API.
  const hasApi = typeof input.setActionHeld === 'function' && input.scheme && typeof input.scheme.note === 'function';
  expect('InputManager exposes scheme + setActionHeld (virtual sources)', hasApi);
  if (hasApi) {
    input.scheme.note('touch');
    input.setActionHeld('fire', true);
    input.setActionHeld('aim', true);
    const t = input.buildInput();
    expect('touch scheme, unlocked: fire honoured', t.fire === true);
    expect('touch scheme, unlocked: aim honoured', t.aim === true);
    input.setActionHeld('fire', false);
    input.setActionHeld('aim', false);
    expect('touch release clears fire/aim', input.buildInput().fire === false && input.isAiming() === false);
    input.setActionHeld('interact', true);
    const i1 = input.buildInput();
    expect('touch interact press = one interact edge + interactHeld', i1.interact === true && i1.interactHeld === true);
    expect('...the edge is one-shot', input.buildInput().interact === false);
    input.setActionHeld('interact', false);
    input.scheme.note('gamepad');
    input.setActionHeld('fire', true);
    expect('gamepad scheme, unlocked: fire honoured', input.buildInput().fire === true);
    input.setActionHeld('fire', false);
    input.scheme.note('mouse');
    input.setActionHeld('fire', true);
    expect('back on the mouse scheme, unlocked: fire refused again', input.buildInput().fire === false);
    input.setActionHeld('fire', false);
  }
  // Keyboard still drives the same wire fields through the table.
  fire('keydown', { code: 'KeyW' });
  fire('keydown', { code: 'KeyQ' });
  const k = input.buildInput();
  expect('W -> forward, Q -> sailLeft (wire unchanged)', k.forward === true && k.sailLeft === true);
  fire('keyup', { code: 'KeyW' });
  fire('keyup', { code: 'KeyQ' });
  fire('keydown', { code: 'Digit6' });
  expect('6 -> firebomb ammo', input.buildInput().cannonAmmo === 'firebomb');
  fire('keyup', { code: 'Digit6' });

  // Look filter: lock acquired -> first move dropped, then clamped to 300 px.
  globalThis.document.pointerLockElement = body;
  fire('pointerlockchange');
  const y0 = input.getYaw();
  fire('mousemove', { movementX: 900, movementY: 0 });
  expect('first movement after lock is discarded', input.getYaw() === y0, `yaw moved ${input.getYaw() - y0}`);
  fire('mousemove', { movementX: 5000, movementY: 0 });
  const d1 = y0 - input.getYaw();
  const y1 = input.getYaw();
  fire('mousemove', { movementX: 300, movementY: 0 });
  const d2 = y1 - input.getYaw();
  expect('a 5000 px spike turns exactly as far as 300 px', d1 > 0 && Math.abs(d1 - d2) < 1e-12, `5000px ${d1}, 300px ${d2}`);
  fire('mousedown', { button: 0 });
  expect('mouse scheme, locked: click fires', input.buildInput().fire === true);
  fire('mouseup', { button: 0 });
}

// ── The lock helper alone ─────────────────────────────────────────────────
if (LOCK) {
  console.log('\nrequestLockSafe');
  const { requestLockSafe, LookDeltaFilter } = LOCK;
  expect('undefined return -> no throw, request issued', requestLockSafe({ requestPointerLock: () => undefined }) === true);
  expect('missing method -> false', requestLockSafe({}) === false && requestLockSafe(null) === false);
  expect('synchronous throw -> false, no throw', requestLockSafe({ requestPointerLock: () => { throw new Error('x'); } }) === false);
  let retried = 0;
  const el = { requestPointerLock: (o) => { if (o) return Promise.reject(new Error('raw refused')); retried += 1; return Promise.resolve(); } };
  requestLockSafe(el, { unadjustedMovement: true });
  await new Promise((r) => setTimeout(r, 5));
  expect('raw-input refusal retries once without options', retried === 1);
  const f = new LookDeltaFilter();
  f.onLockAcquired();
  expect('filter drops the first delta after lock', f.filter(50, 50) === null);
  const c = f.filter(-800, 40);
  expect('filter clamps to -300 / passes 40', c && c.dx === -300 && c.dy === 40);
  expect('filter drops NaN', f.filter(NaN, 1) === null);
}

// ── Chart wheel / trackpad ────────────────────────────────────────────────
if (WHEEL) {
  console.log('\nChart zoom from wheel and trackpad');
  const { wheelToChartAction } = WHEEL;
  const total = (events) => events.reduce((z, e) => z * wheelToChartAction(e).zoomFactor, 1);
  const flick = total(Array.from({ length: 40 }, () => ({ deltaX: 0, deltaY: -4, deltaMode: 0 })));
  expect(`trackpad flick 40 x deltaY -4 -> 1.3-1.6x (${flick.toFixed(3)})`, flick >= 1.3 && flick <= 1.6);
  const notch = total([{ deltaX: 0, deltaY: -100, deltaMode: 0 }]);
  expect(`one mouse notch -100 -> 1.2-1.3x (${notch.toFixed(3)})`, notch >= 1.2 && notch <= 1.3);
  const pinch = total(Array.from({ length: 10 }, () => ({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true })));
  expect(`pinch 10 x ctrl deltaY -10 -> 2-3x (${pinch.toFixed(3)})`, pinch >= 2 && pinch <= 3);
  const out = total([{ deltaX: 0, deltaY: 100, deltaMode: 0 }]);
  expect(`one notch out is the inverse-ish zoom-out (${out.toFixed(3)})`, out >= 0.78 && out <= 0.84);
  const huge = wheelToChartAction({ deltaX: 0, deltaY: -5000, deltaMode: 0 }).zoomFactor;
  expect(`one huge event never saturates (<= 1.25, got ${huge.toFixed(3)})`, huge <= 1.25);
  const line = wheelToChartAction({ deltaX: 0, deltaY: -3, deltaMode: 1 }).zoomFactor;
  expect(`Firefox line mode -3 lines zooms in (${line.toFixed(3)})`, line > 1.05 && line <= 1.25);
  const pan = wheelToChartAction({ deltaX: 30, deltaY: 0, deltaMode: 0 });
  expect('two-finger sideways scroll pans, does not zoom', pan.panDx === -30 && pan.zoomFactor === 1);
  const pinchPan = wheelToChartAction({ deltaX: 30, deltaY: -10, ctrlKey: true });
  expect('a pinch never pans', pinchPan.panDx === 0);
  expect('Game.ts uses wheelToChartAction (no fixed 1.18 step left)',
    GAME_SRC.includes('wheelToChartAction(') && !/\b1\.18\b/.test(GAME_SRC));
  expect('Game.ts blocks ctrl-wheel page zoom and Safari gesture zoom in a match',
    /ctrlKey/.test(GAME_SRC) && /gesturestart/.test(GAME_SRC));
}

console.log(failures === 0 ? '\nPASS test-input-bindings' : `\nFAIL test-input-bindings (${failures})`);
process.exit(failures === 0 ? 0 : 1);
