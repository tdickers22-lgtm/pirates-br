#!/usr/bin/env node
// TOUCH CORE (b1.4b; crossdevice-01, crossdevice-04, liveplay-03, vm:holes:6,
// vm:crossdevice:5). Logic half: no browser, no ports.
//
//  • The virtual stick maps to the SAME bindings rows as WASD (8 directions,
//    deadzone), a fire tap survives at least one input tick, drag-to-look is
//    0.0055 rad/px x sens x fovScale (150 px -> 0.35-1.2 rad).
//  • A touch Interact HOLD through the real InputManager is the keyboard [X]
//    hold on the wire: interact edge once, interactHeld on every tick until the
//    release, and the release (pointerup / pointercancel / lostpointercapture ->
//    VirtualInputSource.release) drops it.
//  • Those exact packets, replayed into a real server Match at a breached hull
//    with a plank, CLOSE the hole in 1.5 s; the same hold cancelled at 0.4 s
//    (under one 0.9 s swing, no press edge) does not.
//
// The browser half (CDP touch at 844x390 and 1024x768 on the runner's stack) is
// slice b1.4b2; see the lane report.
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const tryImport = async (path) => {
  try { return await import(path); } catch (err) { expect(`import ${path}`, false, String(err?.message ?? err).split('\n')[0]); return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const V = await tryImport('../src/client/input/VirtualInputSource.ts');
const IM = await tryImport('../src/client/input/InputManager.ts');
const { Match } = await import('../src/server/core/Match.ts');
const { SHIP } = await import('../src/shared/constants/index.ts');

// ── The stick and the buttons ─────────────────────────────────────────────
console.log('\nVirtual stick and buttons');
if (V && IM) {
  const im = new IM.InputManager();
  im.scheme.note('touch');
  const src = new V.VirtualInputSource(im);
  const axes = () => im.getMoveAxes();
  src.setStick(0.1, -0.1);
  expect('inside the deadzone nothing moves', axes().x === 0 && axes().z === 0, JSON.stringify(axes()));
  src.setStick(0, -1);
  expect('stick up = moveForward (the W row)', axes().z === 1 && axes().x === 0, JSON.stringify(axes()));
  src.setStick(0.7, -0.7);
  expect('stick up-right = forward + right', axes().z === 1 && axes().x === 1, JSON.stringify(axes()));
  src.setStick(-0.9, 0.1);
  expect('stick left = moveLeft only', axes().x === -1 && axes().z === 0, JSON.stringify(axes()));
  src.setStick(0, 0);
  expect('stick released = stop', axes().x === 0 && axes().z === 0, JSON.stringify(axes()));

  const yaw0 = im.getYaw();
  src.look(150, 0);
  const turned = Math.abs(im.getYaw() - yaw0);
  expect(`150 px drag turns 0.35-1.2 rad (${turned.toFixed(3)})`, turned >= 0.35 && turned <= 1.2);
  expect('dragging right turns right (yaw decreases, same sign as the mouse)', im.getYaw() < yaw0);

  im.buildInput();
  src.press('fire');
  src.release('fire');
  expect('a fire tap is still firing on the next tick (touch needs no pointer lock)', im.buildInput().fire === true);
  await sleep(160);
  expect('...and lets go after its minimum hold', im.buildInput().fire === false);

  src.press('jump');
  const j = im.buildInput();
  expect('Jump press = jumpPressed edge + jump held', j.jumpPressed === true && j.jump === true);
  src.release('jump');
  src.press('reload');
  expect('Reload press = reload one-shot', im.buildInput().reload === true);
  src.releaseAll();
  expect('releaseAll leaves nothing held', !src.isHeld('reload') && im.buildInput().jump === false);
}

// ── Interact hold through the real InputManager ───────────────────────────
console.log('\nInteract is press-and-hold');
const TICK_MS = 1000 / 30;
function recordHold({ holdMs, cancelAtMs = null }) {
  const im = new IM.InputManager();
  im.scheme.note('touch');
  const src = new V.VirtualInputSource(im);
  const frames = [];
  src.press('interact');
  for (let t = 0; t <= 1600; t += TICK_MS) {
    if (cancelAtMs !== null && t >= cancelAtMs && src.isHeld('interact')) src.release('interact');
    if (t >= holdMs && src.isHeld('interact')) src.release('interact');
    const inp = im.buildInput();
    frames.push({ t, interact: inp.interact, interactHeld: inp.interactHeld });
  }
  return frames;
}
let holdFrames = [];
if (V && IM) {
  holdFrames = recordHold({ holdMs: 1500 });
  const during = holdFrames.filter((f) => f.t < 1500);
  expect('one interact edge on the press, none after', holdFrames.filter((f) => f.interact).length === 1 && holdFrames[0].interact);
  expect(`interactHeld true on every tick of the 1.5 s hold (${during.filter((f) => f.interactHeld).length}/${during.length})`,
    during.length > 40 && during.every((f) => f.interactHeld));
  expect('released after the finger lifts', holdFrames.at(-1).interactHeld === false);
  const cancelled = recordHold({ holdMs: 99999, cancelAtMs: 400 });
  expect('pointercancel at 0.4 s releases the hold (no stuck [X])',
    cancelled.filter((f) => f.t >= 400).every((f) => !f.interactHeld)
    && cancelled.filter((f) => f.t < 400).every((f) => f.interactHeld));
}

// ── Replayed into the real server ─────────────────────────────────────────
console.log('\nThe same packets at a breach, on the server');
function replayAtHole(frames) {
  const match = new Match({ matchId: 'touch-repair', botCount: 1 });
  match.state.phase = 'playing';
  match.state.storm.safeRadius = 99999;
  match.state.storm.damagePerSec = 0;
  match.broadcast = () => {};
  const joined = match.addHumanClient({ readyState: 1, bufferedAmount: 0, send() {}, close() {} }, 'Thumbs');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const ship = match.state.ships.find((s) => s.id === joined.shipId);
  const hole = { id: 4242, x: 0.6, y: 0.4, z: 0, patched: false };
  ship.holes = [hole];
  player.pocketWood = 1;
  const stand = () => {
    const c = Math.cos(ship.rotation), s = Math.sin(ship.rotation);
    player.onShipId = ship.id;
    player.atHelm = player.atCannon = player.atCrowNest = false;
    player.position = { x: ship.position.x + hole.x * c + hole.z * s, y: ship.position.y + hole.y, z: ship.position.z - hole.x * s + hole.z * c };
  };
  let seq = 1;
  const ticks = Math.round(1.6 * 60);
  for (let i = 0; i < ticks && !hole.patched; i++) {
    const t = (i * 1000) / 60;
    const f = [...frames].reverse().find((fr) => fr.t <= t) ?? frames[0];
    stand();
    match.handleClientMessage(joined.playerId, {
      type: 'player_input', ts: 0,
      // The arbiter names 'repair' at a breach (Game.ts, unchanged by touch).
      payload: { seq: seq++, yaw: 0, pitch: 0, interact: f.interact, interactHeld: f.interactHeld,
        interactIntent: f.interact || f.interactHeld ? 'repair' : null },
    });
    match.tick();
  }
  const patched = ship.holes.find((h) => h.id === hole.id)?.patched === true || !ship.holes.some((h) => h.id === hole.id && !h.patched);
  return { patched, planksLeft: player.pocketWood };
}
if (holdFrames.length) {
  const held = replayAtHole(holdFrames);
  expect(`holding Interact 1.5 s with a plank closes the hole (swing ${SHIP.HULL_REPAIR_SWING_TIME} s, plank used)`,
    held.patched && held.planksLeft === 0, JSON.stringify(held));
  // The server also patches on a lone [X] press (the throttled one-press path,
  // Match.ts), so the hold is graded on the swing clock instead: 0.4 s of
  // interactHeld with no press edge (a finger cancelled mid-swing) must NOT
  // finish a 0.9 s swing. If the held bit did not drive the work, both would.
  const cut = recordHold({ holdMs: 99999, cancelAtMs: 400 }).map((f) => ({ ...f, interact: false }));
  const cutShort = replayAtHole(cut);
  expect('a hold cancelled at 0.4 s (under one swing) leaves the hole open and the plank unspent',
    !cutShort.patched && cutShort.planksLeft === 1, JSON.stringify(cutShort));
}

console.log(failures ? `\nFAIL test-touch-controls (${failures})` : '\nPASS test-touch-controls');
process.exit(failures ? 1 : 0);
