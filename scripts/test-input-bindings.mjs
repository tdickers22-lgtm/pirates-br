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
  expect('aim answers the two-finger click (Mouse2) AND a key (trackpad table)',
    tokensFor('aim', 'mouse').includes('Mouse2') && tokensFor('aim', 'mouse').some((t) => !t.startsWith('Mouse')));
  const gameSrc = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
  expect('the context menu is suppressed (two-finger click never opens it in a match)',
    /document\.addEventListener\('contextmenu', \(event\) => event\.preventDefault\(\)\)/.test(gameSrc));
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
  // b1.4f: the card is generated from the table (InputGlyphs.legendLines) into
  // the #legend-body [data-legend] slot, so audit the generated mouse+keyboard card.
  const G = await tryImport('../src/client/ui/InputGlyphs.ts');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  expect('index.html #legend-body carries the generated [data-legend] slot', /id="legend-body"[\s\S]{0,800}data-legend/.test(html));
  const legend = (G ? G.legendLines('mouse').join(' ') : '').replace(/\s+/g, ' ');
  const LEGEND_TOKENS = {
    KeyW: /WASD/, KeyA: /WASD/, KeyS: /WASD/, KeyD: /WASD/,
    ArrowUp: /arrow keys/i, ArrowDown: /arrow keys/i, ArrowLeft: /arrow keys/i, ArrowRight: /arrow keys/i,
    Space: /SPACE/i, KeyZ: /\bZ · /, KeyC: /\bC · /, KeyX: /\bX · /, KeyB: /\bB · /, KeyE: /\bE · /,
    KeyR: /\bR · /, KeyG: /\bG · /, KeyP: /\bP · /, KeyM: /\bM · /, KeyL: /\bL · /, KeyI: /Hold I · /,
    KeyQ: /Q\/F|Q flips/, KeyF: /Q\/F/, ShiftLeft: /SHIFT/, ShiftRight: /SHIFT/,
    Digit1: /1–4/, Digit2: /1–4/, Digit3: /1–4/, Digit4: /1–4/,
    Digit5: /5\/6\/7/, Digit6: /5\/6\/7/, Digit7: /5\/6\/7/,
    Digit8: /1[-–]9/, Digit9: /1[-–]9/, Digit0: /0 to take/, F8: /F8/, Escape: /Esc/i,
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
  // Trackpad parity (b1.4h): two-finger click (button 2) and control-click both
  // aim and neither fires; releasing the click releases the aim.
  fire('mousedown', { button: 2 });
  const twoFinger = input.buildInput();
  fire('mouseup', { button: 2 });
  expect('trackpad two-finger click (button 2) aims, does not fire', twoFinger.aim === true && twoFinger.fire === false);
  fire('mousedown', { button: 0, ctrlKey: true });
  const ctrlClick = input.buildInput();
  fire('mouseup', { button: 0, ctrlKey: false });
  const released = input.buildInput();
  expect('control-click aims, does not fire, and lets go on release', ctrlClick.aim === true && ctrlClick.fire === false && released.aim === false && released.fire === false,
    `aim ${ctrlClick.aim} fire ${ctrlClick.fire} after ${released.aim}/${released.fire}`);
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

// ── b1.4g: Controls settings + rebinding (crossdevice-13, crossdevice-14) ──
console.log('\nControls settings: one clamp table, persisted round-trip');
const RB = await tryImport('../src/client/input/rebinding.ts');
const memStore = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
if (RB && B) {
  const { CONTROL_RANGES, clampSetting, loadControlSettings, saveControlSettings, DEFAULT_CONTROL_SETTINGS } = RB;
  const r = CONTROL_RANGES;
  expect('ranges per the spec: mouse 0.2-3.0, ADS 0.3-1.5, touch/stick look 0.3-3.0, buttons 0.8-1.4',
    r.mouseSens.min === 0.2 && r.mouseSens.max === 3.0 && r.adsMult.min === 0.3 && r.adsMult.max === 1.5
    && r.touchLook.min === 0.3 && r.touchLook.max === 3.0 && r.stickLook.min === 0.3 && r.stickLook.max === 3.0
    && r.touchButtonSize.min === 0.8 && r.touchButtonSize.max === 1.4);
  expect('clampSetting clamps both ends and rejects NaN', clampSetting('mouseSens', 9) === 3.0 && clampSetting('mouseSens', 0.01) === 0.2 && clampSetting('adsMult', 'x') === 1.0);
  const st = memStore();
  const custom = { ...DEFAULT_CONTROL_SETTINGS, mouseSens: 2.35, adsMult: 0.55, touchLook: 1.8, stickLook: 0.7, touchButtonSize: 1.25,
    invertY: { mouse: false, gamepad: true, touch: true }, aimAssist: false, vibration: false, rawMouse: true, leftHanded: true, touchButtons: 'off' };
  saveControlSettings(custom, st);
  const back = loadControlSettings(st);
  expect('every Controls setting survives save -> load', JSON.stringify(back) === JSON.stringify(custom), `${JSON.stringify(back)}`);
  st.setItem('piratesBR.controls', JSON.stringify({ mouseSens: 40, adsMult: -1, touchButtons: 'sometimes', invertY: { mouse: 'yes' } }));
  const bad = loadControlSettings(st);
  expect('tampered storage is clamped to the same table', bad.mouseSens === 3.0 && bad.adsMult === 0.3 && bad.touchButtons === 'auto' && bad.invertY.mouse === false);
  const legacy = memStore();
  legacy.setItem('piratesBR.settings', JSON.stringify({ volume: 0.5, muted: false, sensitivity: 1.7 }));
  legacy.setItem('piratesBR.haptics', 'off');
  const mig = loadControlSettings(legacy);
  expect('pre-b1.4g mouse speed and vibration toggle migrate', mig.mouseSens === 1.7 && mig.vibration === false);

  // The one clamp: nobody else spells a sensitivity range.
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const SITES = ['src/client/input/InputManager.ts', 'src/client/menu/MenuController.ts', 'src/client/menu/ControlsSettings.ts', 'src/client/input/GamepadSource.ts', 'src/client/input/TouchControls.ts'];
  const stray = SITES.filter((f) => /Math\.(max|min)\(\s*0\.2\s*,|Math\.min\(\s*(2\.0|2\.5|3\.0|3)\s*,|sensitivity\s*\*\s*100|max=\\?"200\\?"/.test(src(f)));
  expect('no clamp site outside rebinding.ts spells its own sensitivity range', stray.length === 0, stray.join(', '));
  const IMSRC = src('src/client/input/InputManager.ts');
  expect('InputManager clamps through clampSetting from rebinding.ts', /from '\.\/rebinding\.js'/.test(IMSRC) && /clampSetting\('mouseSens'/.test(IMSRC));
  const CSSRC = src('src/client/menu/ControlsSettings.ts');
  expect('the Controls page builds its sliders from CONTROL_RANGES', /CONTROL_RANGES\[key\]/.test(CSSRC) && /input\.min = String\(spec\.min\)/.test(CSSRC) && /input\.max = String\(spec\.max\)/.test(CSSRC));
  const MC = src('src/client/menu/MenuController.ts');
  const HTML = src('index.html');
  expect('the old 0.2-2.0 menu slider is gone and the Controls page is mounted',
    !/settings-sensitivity/.test(HTML) && !/settingsSens/.test(MC) && /mountControlsSettings\(/.test(MC) && /id="settings-controls-mount"/.test(HTML));

  console.log('\nRebinding: conflict swaps, refusals, reset');
  const { rebind, resetBindings, diffBindings, saveBindingTable, loadBindingTable, isRebindable } = RB;
  const { DEFAULT_BINDINGS, validateBindings, setLiveBindings, BINDINGS: LIVE } = B;
  const a = rebind(DEFAULT_BINDINGS, 'reload', 'keyboard', 'KeyX');
  expect('reload -> X swaps interact onto R (both foot)', a.ok && a.table.reload.keyboard[0] === 'KeyX' && a.table.interact.keyboard[0] === 'KeyR'
    && a.swapped.length === 1 && a.swapped[0].action === 'interact', JSON.stringify(a.ok ? a.swapped : a.reason));
  expect('the swapped table still validates', a.ok && validateBindings(a.table).length === 0);
  const g = rebind(DEFAULT_BINDINGS, 'special', 'gamepad', 'Pad:LS.click');
  expect('pad: special -> LS click swaps keg onto RS click', g.ok && g.table.special.gamepad[0] === 'Pad:LS.click' && g.table.keg.gamepad[0] === 'Pad:RS.click');
  const q = rebind(DEFAULT_BINDINGS, 'crouch', 'keyboard', 'KeyQ');
  expect('crouch -> Q needs no swap (Q is trim at the helm, page in the wheel)', q.ok && q.swapped.length === 0 && q.table.trimLeft.keyboard[0] === 'KeyQ');
  const alt = rebind(DEFAULT_BINDINGS, 'aim', 'keyboard', 'KeyV', 1);
  expect('slot 1 replaces only the alternate (aim keeps Mouse2, ShiftLeft -> V)', alt.ok && alt.table.aim.keyboard[0] === 'Mouse2' && alt.table.aim.keyboard[1] === 'KeyV');
  expect('pause, wheel pick and look are fixed; Escape and Pad:Menu are refused',
    !isRebindable('pause', 'keyboard') && !isRebindable('wheelPick', 'gamepad') && !isRebindable('look', 'keyboard')
    && !rebind(DEFAULT_BINDINGS, 'reload', 'keyboard', 'Escape').ok && !rebind(DEFAULT_BINDINGS, 'reload', 'gamepad', 'Pad:Menu').ok);
  const bst = memStore();
  saveBindingTable(a.table, bst);
  const stored = JSON.parse(bst.getItem('piratesBR.bindings') ?? '{}');
  expect('only the changed rows persist', Object.keys(stored).sort().join(',') === 'interact,reload', Object.keys(stored).join(','));
  const reloaded = loadBindingTable(bst);
  expect('stored rebinds load back', reloaded.reload.keyboard[0] === 'KeyX' && reloaded.interact.keyboard[0] === 'KeyR');
  bst.setItem('piratesBR.bindings', JSON.stringify({ reload: { keyboard: ['KeyX'] } }));
  expect('a stored table that would clash falls back to the defaults', loadBindingTable(bst).reload.keyboard[0] === 'KeyR');
  const reset = resetBindings();
  saveBindingTable(reset, bst);
  expect('reset restores every default and clears storage', Object.keys(diffBindings(reset)).length === 0 && bst.getItem('piratesBR.bindings') === null
    && JSON.stringify(reset) === JSON.stringify(DEFAULT_BINDINGS));

  if (IM) {
    console.log('\nInputManager follows the live table and the settings');
    const { body, fire } = makeDom(() => undefined);
    globalThis.localStorage = memStore();
    const input = new IM();
    input.init(body);
    setLiveBindings(a.table);
    expect('live BINDINGS row changed', LIVE.reload.keyboard[0] === 'KeyX');
    fire('keydown', { code: 'KeyX' });
    const viaX = input.buildInput().reload === true;
    fire('keyup', { code: 'KeyX' });
    input.buildInput();
    fire('keydown', { code: 'KeyR' });
    const viaR = input.buildInput().reload === true;
    fire('keyup', { code: 'KeyR' });
    expect('after the rebind X reloads and R does not', viaX && !viaR, `X ${viaX} R ${viaR}`);
    setLiveBindings(resetBindings());
    fire('keydown', { code: 'KeyR' });
    expect('reset: R reloads again', input.buildInput().reload === true);
    fire('keyup', { code: 'KeyR' });
    input.buildInput();
    const pitchStep = (fn) => { input.setLook(0, 0); fn(); return input.getPitch(); };
    input.applyControlSettings({ invertY: { mouse: false, gamepad: false, touch: false } });
    const pMouse = pitchStep(() => input.applyLookDelta(0, 100));
    input.applyControlSettings({ invertY: { mouse: true, gamepad: false, touch: false } });
    const pMouseInv = pitchStep(() => input.applyLookDelta(0, 100));
    const pTouch = pitchStep(() => input.applyTouchLook(0, 20));
    expect('invert Y flips the mouse only (touch keeps its sign)', pMouse < 0 && Math.abs(pMouseInv + pMouse) < 1e-12 && pTouch < 0, `${pMouse} ${pMouseInv} ${pTouch}`);
    input.applyControlSettings({ invertY: { mouse: false, gamepad: false, touch: false }, touchLook: 2 });
    const pTouch2 = pitchStep(() => input.applyTouchLook(0, 20));
    expect('touch look 2.0 turns twice as far as 1.0', Math.abs(pTouch2 - 2 * pTouch) < 1e-12, `${pTouch2} vs ${pTouch}`);
    input.applyControlSettings({ adsMult: 0.5 });
    globalThis.document.pointerLockElement = body; // the mouse scheme aims only while locked
    fire('pointerlockchange');
    fire('keydown', { code: 'ShiftLeft' });
    const pAds = pitchStep(() => input.applyLookDelta(0, 100));
    fire('keyup', { code: 'ShiftLeft' });
    expect('ADS x0.5 halves the look while aiming', Math.abs(pAds - 0.5 * pMouse) < 1e-12, `${pAds} vs ${pMouse}`);
    input.applyControlSettings({ mouseSens: 99, vibration: false });
    expect('applyControlSettings clamps through the same table and drives haptics', input.getSensitivity() === 3.0 && input.haptics.isEnabled() === false);
    input.setSensitivity(0.01);
    expect('setSensitivity clamps to 0.2', input.getSensitivity() === 0.2);
    input.applyControlSettings({ rawMouse: true });
    expect('raw mouse asks for unadjustedMovement', input.lockOptions()?.unadjustedMovement === true);
  }
}

console.log(failures === 0 ? '\nPASS test-input-bindings' : `\nFAIL test-input-bindings (${failures})`);
process.exit(failures === 0 ? 0 : 1);
