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


// ── Touch contexts I (b1.4c): helm, cannon, swim, tools, carry ────────────
console.log('\nTouch contexts (b1.4c)');
const TC = await tryImport('../src/client/input/touchContexts.ts');
if (TC) {
  const base = { atHelm: false, atCannon: false, swimming: false, carrying: false, equippedTool: null, anchored: false };
  const ctx = (o) => TC.resolveTouchContext({ ...base, ...o });
  expect('context table: helm > cannon > swim > carry > tool > foot',
    ctx({ atHelm: true, swimming: true }) === 'helm' && ctx({ atCannon: true }) === 'cannon'
    && ctx({ swimming: true, carrying: true }) === 'swim' && ctx({ carrying: true, equippedTool: 'bucket' }) === 'carry'
    && ctx({ equippedTool: 'bucket' }) === 'tool' && ctx({ equippedTool: 'spyglass' }) === 'foot' && ctx({}) === 'foot');
  const ids = (c, anchored = false) => TC.buttonsFor(c, anchored).map((b) => b.id);
  const has = (c, want, anchored = false) => want.every((id) => ids(c, anchored).includes(id));
  expect(`helm: Sails up/down, Trim L/R, Leave (${ids('helm')})`, has('helm', ['sails-up', 'sails-down', 'trim-left', 'trim-right', 'leave']) && !ids('helm').includes('fire'));
  expect('helm: Weigh anchor only while anchored', !ids('helm').includes('anchor') && ids('helm', true).includes('anchor'));
  expect(`cannon: Fire, three ammo chips, Leave, no stick (${ids('cannon')})`,
    has('cannon', ['fire', 'ammo-round', 'ammo-fire', 'ammo-chain', 'leave']) && !TC.stickEnabled('cannon') && !TC.stickEnabled('helm'));
  expect(`swim: Up and Down (${ids('swim')})`, has('swim', ['swim-up', 'swim-down']) && TC.stickEnabled('swim'));
  expect(`carry: Drop, no Fire (${ids('carry')})`, has('carry', ['drop']) && !ids('carry').includes('fire'));
  const fireSpec = TC.TOUCH_BUTTONS.find((b) => b.id === 'fire');
  expect('tool: the big button reads Bail / Dig with a ring',
    TC.labelFor(fireSpec, 'tool', 'bucket') === 'Bail' && TC.labelFor(fireSpec, 'tool', 'shovel') === 'Dig' && fireSpec.ring === true);
  const spring = new TC.HelmSlider(true);
  spring.set(0.8);
  const r1 = spring.steer();
  spring.release();
  const latched = new TC.HelmSlider(false);
  latched.set(-0.9); latched.release();
  expect('slider: right = steerRight, spring centres on release, latched stays over',
    r1.steerRight && !r1.steerLeft && !spring.steer().steerRight && latched.steer().steerLeft);
  const tp = TC.touchProgress({ equippedTool: 'bucket', bailScoopProgress: 0.25, bucketFilled: true, hullRepairProgress: 0, digProgress: null, anchorRaiseProgress: 0.4 });
  expect('fill rings: bail reads the scoop clock, anchor reads the raise, no repair -> own clock',
    Math.abs(tp.fire - 0.75) < 1e-9 && Math.abs(tp.anchor - 0.4) < 1e-9 && tp.interact === null);
}

console.log('\nTouch contexts on the real server');
function stationMatch(id) {
  const match = new Match({ matchId: id, botCount: 1 });
  match.state.phase = 'playing';
  match.state.storm.safeRadius = 99999;
  match.state.storm.damagePerSec = 0;
  match.broadcast = () => {};
  const joined = match.addHumanClient({ readyState: 1, bufferedAmount: 0, send() {}, close() {} }, 'Thumbs');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const ship = match.state.ships.find((s) => s.id === joined.shipId);
  const im = new IM.InputManager();
  im.scheme.note('touch');
  const src = new V.VirtualInputSource(im);
  let seq = 1;
  const stand = { at: null };
  // One 60 Hz server tick with the packet the touch player would send now.
  // stand.at (walking to a station) keeps her aboard at that spot, as the
  // repair replay above does: spawn parks the hull at a berth with nobody on it.
  const send = (intent = null, route = null) => {
    if (stand.at && !player.atHelm && !player.atCannon) { player.onShipId = ship.id; stand.at(); }
    let input = im.buildInput();
    if (route) input = route(input);
    input.seq = seq++;
    if (intent && (input.interact || input.interactHeld)) input.interactIntent = intent;
    match.handleClientMessage(joined.playerId, { type: 'player_input', ts: 0, payload: input });
    match.tick();
    return input;
  };
  const tap = (action, intent) => { src.press(action); send(intent); src.release(action); send(); };
  return { match, player, ship, im, src, send, tap, stand };
}
if (TC && V && IM) {
  // Take the helm by a tap on Interact, steer with the slider, leave by Leave.
  const h = stationMatch('touch-helm');
  h.stand.at = () => h.match.snapPlayerToHelm(h.player, h.ship);
  h.ship.anchored = false;
  h.tap('interact', 'helm');
  expect('a tap on Interact at the wheel takes the helm', h.player.atHelm === true);
  expect('the helm context is what the overlay shows there',
    TC.resolveTouchContext({ atHelm: h.player.atHelm, atCannon: false, swimming: false, carrying: false, equippedTool: null, anchored: false }) === 'helm');
  h.ship.sailHeight = 1;
  const r0 = h.ship.rotation;
  h.ship.velocity = { x: Math.sin(r0) * 7, y: 0, z: Math.cos(r0) * 7 };
  const slider = new TC.HelmSlider(true);
  slider.set(0.8);
  for (let i = 0; i < 180; i++) {
    const want = slider.steer();
    for (const a of ['steerLeft', 'steerRight']) want[a] ? h.src.press(a) : h.src.release(a);
    h.send();
  }
  slider.release();
  h.src.release('steerRight');
  const r1 = h.ship.rotation;
  // yaw r faces (sin r, cos r); facing +Z the right hand is -X, so starboard of heading r0 is (-cos r0, sin r0).
  const starboard = Math.sin(r1) * -Math.cos(r0) + Math.cos(r1) * Math.sin(r0);
  expect(`slider right for 3 s turns the bow to starboard (bow . starboard0 = ${starboard.toFixed(3)}, rotation ${r0.toFixed(3)} -> ${r1.toFixed(3)})`,
    starboard > 0.05);
  h.stand.at = null;
  h.tap('interact');
  expect('Leave (the [X] edge) frees the helm', h.player.atHelm === false);

  // Cannon: tap Interact at a gun, touch Fire spawns a ball.
  const c = stationMatch('touch-cannon');
  c.stand.at = () => c.match.snapPlayerToCannon(c.player, c.ship, 0);
  c.tap('interact', 'cannon');
  expect('a tap on Interact at a gun mans the cannon', c.player.atCannon === true);
  // Past the gun's own cooldown (the opening truce of a station).
  c.ship.cannonCooldowns = c.ship.cannonCooldowns.map(() => 0);
  for (let i = 0; i < 30; i++) c.send();
  const isBall = (p) => p.ownerId === c.player.id && /cannon|chain|fire/i.test(String(p.type ?? p.kind ?? p.ammo ?? ''));
  const balls0 = c.match.state.projectiles.filter(isBall).length;
  c.src.press('fire');
  c.src.release('fire');
  let fired = 0;
  for (let i = 0; i < 12; i++) { c.send(); fired = Math.max(fired, c.match.state.projectiles.filter(isBall).length - balls0); }
  const sample = c.match.state.projectiles.at(-1);
  expect(`a touch Fire tap at the manned cannon spawns a cannonball (${fired}; last ${sample ? JSON.stringify({ type: sample.type, kind: sample.kind, ammo: sample.ammo, owner: sample.ownerId === c.player.id }) : 'none'})`,
    fired >= 1 && c.player.atCannon === true);

  // Bail: the big button with a bucket in hand scoops through useItem.
  const b = stationMatch('touch-bail');
  b.stand.at = () => b.match.snapPlayerToHelm(b.player, b.ship);
  b.player.equippedTool = 'bucket';
  b.ship.waterLevel = 0.6;
  const w0 = b.ship.waterLevel;
  const route = (inp) => TC.routeHeldTool(inp, 'bucket', false, b.im.isFiring());
  b.src.press('fire');
  let useItemTicks = 0; let fireLeaked = 0; let scoops = 0; let wasFilled = false;
  for (let i = 0; i < 150; i++) {
    const sent = b.send(null, route);
    if (sent.useItem) useItemTicks++;
    if (sent.fire) fireLeaked++;
    if (b.player.bucketFilled && !wasFilled) scoops++;
    wasFilled = b.player.bucketFilled;
  }
  b.src.release('fire');
  expect(`holding Bail 2.5 s scoops (${scoops} scoops, water ${w0} -> ${b.ship.waterLevel.toFixed(3)}, useItem ${useItemTicks}/150, fire leaked ${fireLeaked})`,
    scoops >= 2 && b.ship.waterLevel < w0 && fireLeaked === 0);
}

console.log(failures ? `\nFAIL test-touch-controls (${failures})` : '\nPASS test-touch-controls');
process.exit(failures ? 1 : 0);
