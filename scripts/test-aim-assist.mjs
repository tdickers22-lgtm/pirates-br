#!/usr/bin/env node
// AIM ASSIST, TOUCH AND GAMEPAD ONLY (b1.4h; D13, crossdevice target spec section 3).
//
//  • Slowdown x0.55 while the crosshair is within 2.5 deg (x fovScale) of an
//    enemy hitbox <= 60 m away with line of sight; 1.0 everywhere else.
//  • Magnetism only while aiming, inside 4 deg, <= 3 deg/s, dt clamped to 50 ms,
//    never past the target: it cannot snap, even across a 2 s hitch.
//  • Never for the mouse (a Mac trackpad is the mouse scheme), never at a cannon
//    or the helm, never with the Wrecker's Glass or the spyglass, never through
//    cover (the real hull prism the server shoots through).
//  • The real InputManager under a DOM stub: the pad and touch look slow down on
//    a target, the mouse never does, and magnetism turns the view only while Aim
//    is held.
//
// Pure: no DOM, no stack, no browser.
import { readFileSync } from 'node:fs';

let failures = 0;
function expect(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
}

const A = await import('../src/client/input/AimAssist.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const DEG = Math.PI / 180;
const { AIM_ASSIST, aimAssistAllowed, lookSlowdown, magnetismStep, collectAimTargets, makeAimLineOfSight } = A;

// Crosshair at yaw 0 / pitch 0 looks down +z from the origin at eye height 0.
const eye = { x: 0, y: 0, z: 0 };
const at = (deg, dist, radius = 0.45) => ({ x: Math.sin(deg * DEG) * dist, y: 0, z: Math.cos(deg * DEG) * dist, radius });
const clear = () => true;
const frame = (over = {}) => ({
  scheme: 'gamepad', enabled: true, context: 'foot', weaponId: 'flintlock', scoped: false,
  eye, targets: [at(2, 30, 0)], los: clear, fovScale: 1, ...over,
});

console.log('\nThe spec numbers');
expect('slowdown x0.55, 2.5 deg, 60 m, magnetism 4 deg at <= 3 deg/s', AIM_ASSIST.slowdown === 0.55 && AIM_ASSIST.slowdownConeDeg === 2.5
  && AIM_ASSIST.maxRangeM === 60 && AIM_ASSIST.magnetConeDeg === 4 && AIM_ASSIST.magnetRateDegPerSec === 3);

console.log('\nWho gets it');
expect('mouse (and the trackpad, which is the mouse scheme) never', !aimAssistAllowed(frame({ scheme: 'mouse' })) && lookSlowdown(frame({ scheme: 'mouse' }), 0, 0) === 1
  && magnetismStep(frame({ scheme: 'mouse' }), 0, 0, true, 0.016).dYaw === 0);
expect('gamepad and touch do', lookSlowdown(frame(), 0, 0) === 0.55 && lookSlowdown(frame({ scheme: 'touch' }), 0, 0) === 0.55);
expect('the setting off turns it off', lookSlowdown(frame({ enabled: false }), 0, 0) === 1);
for (const context of ['cannon', 'helm', null]) {
  const f = frame({ context });
  expect(`zero at ${context ?? 'no context'}`, lookSlowdown(f, 0, 0) === 1 && magnetismStep(f, 0, 0, true, 0.016).dYaw === 0);
}
expect('swimming is assisted', lookSlowdown(frame({ context: 'swim' }), 0, 0) === 0.55);
for (const weaponId of ['eye_of_reach', 'ship_cannon']) {
  const f = frame({ weaponId });
  expect(`zero with ${weaponId}`, lookSlowdown(f, 0, 0) === 1 && magnetismStep(f, 0, 0, true, 0.016).dYaw === 0);
}
expect('zero with the spyglass up', lookSlowdown(frame({ scoped: true }), 0, 0) === 1);

console.log('\nSlowdown cone, range, cover');
expect('a target 2 deg off (point hitbox) slows', lookSlowdown(frame({ targets: [at(2, 30, 0)] }), 0, 0) === 0.55);
expect('a target 3 deg off (point hitbox) does not', lookSlowdown(frame({ targets: [at(3, 30, 0)] }), 0, 0) === 1);
expect('the hitbox edge counts: 3 deg off at 10 m with a 0.45 m torso slows', lookSlowdown(frame({ targets: [at(3, 10)] }), 0, 0) === 0.55);
expect('the cone narrows with the FOV (2 deg off at fovScale 0.5 does not slow)', lookSlowdown(frame({ fovScale: 0.5 }), 0, 0) === 1);
expect('61 m does not slow, 59 m does', lookSlowdown(frame({ targets: [at(0, 61, 0)] }), 0, 0) === 1 && lookSlowdown(frame({ targets: [at(0, 59, 0)] }), 0, 0) === 0.55);
expect('behind the player (180 deg) does not', lookSlowdown(frame({ targets: [at(180, 20)] }), 0, 0) === 1);
const covered = frame({ los: () => false });
expect('zero behind cover (slowdown and magnetism)', lookSlowdown(covered, 0, 0) === 1 && magnetismStep(covered, 0, 0, true, 0.016).dYaw === 0);
// A covered near target must not hide a visible one further out in the cone.
const two = frame({ targets: [at(1, 20, 0), at(2, 40, 0)], los: (_f, t) => t.z > 30 });
expect('a covered target does not mask a visible one', lookSlowdown(two, 0, 0) === 0.55);

console.log('\nThe real cover test (shared hull prism the server shoots through)');
const shipType = Object.keys(SHIP_STATS)[0];
const state = { islands: [], ships: [{ id: 's', type: shipType, position: { x: 0, y: 0, z: 15 }, rotation: 0 }] };
const los = makeAimLineOfSight(state);
expect(`a ${shipType} hull between eye and target blocks`, los({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: 30 }) === false);
expect('a clear line is clear', los({ x: 0, y: 1.5, z: 0 }, { x: 40, y: 1, z: 0 }) === true);
expect('with that hull, a gamepad gets no slowdown on the hidden pirate',
  lookSlowdown(frame({ eye: { x: 0, y: 1.5, z: 0 }, targets: [{ x: 0, y: 1.5, z: 30, radius: 0.45 }], los }), 0, 0) === 1);

console.log('\nMagnetism: only while aiming, bounded, never snaps');
const mag = frame({ targets: [at(3.5, 30, 0)] });
expect('zero when not aiming', magnetismStep(mag, 0, 0, false, 0.016).dYaw === 0);
const s1 = magnetismStep(mag, 0, 0, true, 0.016);
expect('pulls toward the target while aiming', s1.dYaw > 0, `dYaw ${s1.dYaw}`);
expect('outside 4 deg: nothing', magnetismStep(frame({ targets: [at(4.5, 30, 0)] }), 0, 0, true, 0.016).dYaw === 0);
// 1 s at 60 fps: total <= 3 deg, every step <= 3 deg/s x dt.
let yaw = 0; let pitch = 0; let maxStep = 0;
for (let i = 0; i < 60; i += 1) {
  const m = magnetismStep(mag, yaw, pitch, true, 1 / 60);
  maxStep = Math.max(maxStep, Math.hypot(m.dYaw, m.dPitch));
  yaw += m.dYaw; pitch += m.dPitch;
}
expect('1 s of magnetism turns <= 3 deg', yaw / DEG <= 3 + 1e-9 && yaw / DEG > 2.5, `${(yaw / DEG).toFixed(4)} deg`);
expect('no step exceeds 3 deg/s x dt', maxStep <= 3 * DEG / 60 + 1e-12, `${maxStep / DEG} deg`);
const hitch = magnetismStep(mag, 0, 0, true, 2.0);
expect('a 2 s hitch moves <= 3 deg/s x 50 ms (never snaps)', Math.hypot(hitch.dYaw, hitch.dPitch) <= 3 * DEG * 0.05 + 1e-12, `${Math.hypot(hitch.dYaw, hitch.dPitch) / DEG} deg`);
const bad = magnetismStep(mag, 0, 0, true, Number.NaN);
expect('a NaN dt moves nothing', bad.dYaw === 0 && bad.dPitch === 0);
// Nearly on target: the step stops exactly on it, never past it.
const near = frame({ targets: [at(0.01, 30, 0)] });
const n1 = magnetismStep(near, 0, 0, true, 0.05);
expect('never overshoots (0.01 deg off -> lands on it)', Math.abs(n1.dYaw / DEG - 0.01) < 1e-9, `${n1.dYaw / DEG}`);
// Pitch too: a target above pulls pitch up within the same bound.
const up = frame({ targets: [{ x: 0, y: Math.sin(2 * DEG) * 30, z: Math.cos(2 * DEG) * 30, radius: 0 }] });
const u1 = magnetismStep(up, 0, 0, true, 0.05);
expect('pulls pitch toward a target above, same bound', u1.dPitch > 0 && Math.abs(u1.dYaw) < 1e-12 && u1.dPitch <= 3 * DEG * 0.05 + 1e-12);
// Across the yaw seam: the short way round.
const seam = frame({ targets: [at(-1, 30, 0)] });
const sw = magnetismStep(seam, 2 * Math.PI, 0, true, 0.05);
expect('across the +-pi seam it turns the short way', sw.dYaw < 0 && Math.abs(sw.dYaw) <= 3 * DEG * 0.05 + 1e-12);

console.log('\nTargets: enemies only');
const me = { id: 'me', crewId: 'c1', position: { x: 0, y: 0, z: 0 } };
const players = [
  { id: 'me', crewId: 'c1', state: 'alive', position: { x: 0, y: 0, z: 5 } },
  { id: 'mate', crewId: 'c1', state: 'alive', position: { x: 0, y: 0, z: 6 } },
  { id: 'foe', crewId: 'c2', state: 'alive', position: { x: 0, y: 0, z: 7 } },
  { id: 'downed', crewId: 'c2', state: 'downed', position: { x: 0, y: 0, z: 8 } },
  { id: 'far', crewId: 'c2', state: 'alive', position: { x: 0, y: 0, z: 400 } },
];
const sharks = [{ id: 'sh', health: 50, position: { x: 3, y: -1, z: 3 } }, { id: 'gone', health: 50, despawnTimer: 1, position: { x: 3, y: -1, z: 3 } }];
const tg = collectAimTargets({ players, sharks }, me);
expect('one enemy pirate (chest height) + one live shark', tg.length === 2 && tg[0].z === 7 && tg[0].y === 1 && tg[1].x === 3, JSON.stringify(tg));

console.log('\nThe real InputManager: pad/touch slowed, mouse never, magnetism only while aiming');
{
  const listeners = new Map();
  const add = (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
  const fire = (type, event = {}) => { for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, ...event }); };
  const body = { addEventListener: add, requestPointerLock: () => undefined };
  globalThis.document = { body, activeElement: null, pointerLockElement: null, visibilityState: 'visible', exitPointerLock: () => {}, addEventListener: add };
  globalThis.window = { addEventListener: add, location: { search: '' } };
  const { InputManager } = await import('../src/client/input/InputManager.ts');
  const input = new InputManager();
  input.init(body);
  input.setPlayContext('foot');
  const world = { eye, targets: [at(2, 30, 0)], los: clear, weaponId: 'flintlock', scoped: false };
  // The slowdown is computed for the crosshair where the frame found it: tick at yaw 0.
  const tick = (w) => { input.setLook(0, 0); input.tickAimAssist(1 / 60, w); };
  const padTurn = () => { input.setLook(0, 0); input.applyPadLook(0.01, 0); return -input.getYaw(); };
  input.scheme.note('gamepad');
  tick(null);
  const free = padTurn();
  tick(world);
  const slowed = padTurn();
  expect('gamepad look on a target runs at x0.55', Math.abs(slowed / free - 0.55) < 1e-9, `${slowed / free}`);
  tick({ ...world, weaponId: 'eye_of_reach' });
  expect("the Wrecker's Glass is not slowed", Math.abs(padTurn() - free) < 1e-12);
  input.scheme.note('touch');
  tick(null);
  input.setLook(0, 0); input.applyTouchLook(10, 0); const tFree = -input.getYaw();
  tick(world);
  input.setLook(0, 0); input.applyTouchLook(10, 0); const tSlow = -input.getYaw();
  expect('touch look on a target runs at x0.55', Math.abs(tSlow / tFree - 0.55) < 1e-9, `${tSlow / tFree}`);
  // Magnetism: not aiming -> no drift; aim held on the pad -> drift <= 3 deg/s.
  input.scheme.note('gamepad');
  input.setLook(0, 0);
  input.tickAimAssist(1 / 60, world);
  expect('no drift while not aiming', input.getYaw() === 0);
  input.setActionHeld('aim', true);
  for (let i = 0; i < 30; i += 1) input.tickAimAssist(1 / 60, world);
  const drift = input.getYaw() / DEG;
  expect('aiming on the pad drifts toward the target, <= 1.5 deg in 0.5 s', drift > 1 && drift <= 1.5 + 1e-9, `${drift} deg`);
  input.setActionHeld('aim', false);
  // Mouse: never slowed, never pulled, even with the world handed over.
  input.scheme.note('mouse');
  globalThis.document.pointerLockElement = body;
  fire('pointerlockchange');
  fire('mousemove', { movementX: 1, movementY: 0 }); // the post-lock warp is dropped
  input.tickAimAssist(1 / 60, world);
  input.setLook(0, 0);
  fire('mousemove', { movementX: 100, movementY: 0 });
  const mouseTurn = -input.getYaw();
  expect('mouse look is never slowed', Math.abs(mouseTurn - 100 * 0.002 * input.getSensitivity()) < 1e-9, `${mouseTurn}`);
  fire('keydown', { code: 'ShiftLeft' });
  input.setLook(0, 0);
  for (let i = 0; i < 30; i += 1) input.tickAimAssist(1 / 60, world);
  expect('mouse aiming is never pulled', input.getYaw() === 0);
  fire('keyup', { code: 'ShiftLeft' });
  expect('probe read says off for the mouse', input.getAimAssistState().slowdown === 1 && input.getAimAssistState().scheme === null);
}

console.log('\nWiring');
const game = readFileSync(new URL('../src/client/core/Game.ts', import.meta.url), 'utf8');
expect('Game feeds tickAimAssist every frame with enemies and the shared cover test',
  /this\.updateAimAssist\(\);/.test(game) && /tickAimAssist\(this\.frameDt, \{/.test(game) && /collectAimTargets\(this\.state, me\)/.test(game) && /makeAimLineOfSight\(this\.state\)/.test(game));

console.log(failures === 0 ? '\nPASS test-aim-assist' : `\nFAIL test-aim-assist (${failures})`);
process.exit(failures === 0 ? 0 : 1);
