#!/usr/bin/env node
// A HELD GUARD STAYS HELD.
//
// test-block.mjs pins what a raised guard DOES; this pins that it stays raised.
// The guard used to be one flat conjunction re-evaluated every tick, so it was
// as fragile as the noisiest term in it. Driving a real human client through the
// real Match at 62.5 Hz with an unchanging aim-held input found two ways it
// blinked off while RMB was never released:
//   • one packet arriving without the aim bit (a coalesced/dropped frame under
//     snapshot load, or a pointer-lock blip clearing the button set)
//   • a wave flipping a shoreline walker to 'swimming' for a single tick
// Either one opened the pirate up to a full-weight swing through a raised sword.
//
// It also pins the drops that must STAY instant: swinging, sheathing the
// cutlass, filling your hands with a chest, taking a station, and letting go.
//
//   node --import tsx scripts/test-block-hold.mjs
import { Match } from '../src/server/core/Match.ts';
import { SERVER_TICK_MS, PLAYER } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = SERVER_TICK_MS / 1000;
const fakeWs = { readyState: 1, send() {}, close() {}, on() {}, once() {}, removeListener() {} };

const HELD = {
  seq: 1, ts: 0,
  forward: false, back: false, left: false, right: false,
  jump: false, jumpPressed: false, crouch: false,
  fire: false, useItem: false, aim: true,
  interact: false, interactHeld: false, anchor: false,
  sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
  trade: false, reload: false, placeKeg: false, dropChest: false,
  specialAttack: false, slot: null, cannonAmmo: null,
  yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
  barrelTakeAll: false, interactIntent: null,
};

/** A real human client, cutlass drawn, standing on foot off any ship. */
function makeGuard(label) {
  const match = new Match({ matchId: `block-hold-${label}`, botCount: 2 });
  match.state.phase = 'playing';
  const joined = match.addHumanClient(fakeWs, 'Auditor');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const client = match.clients.get(joined.playerId);
  player.activeSlot = player.weapons.findIndex((w) => w?.weaponId === 'cutlass');
  player.onShipId = null;
  player.shipId = null;
  player.respawnProtectionTimer = 0;
  player.state = 'alive';
  return { match, player, client };
}

/** Run `ticks` ticks, calling shape(i) to build this tick's held input, and
 *  return how many ticks (after the guard first engages) had the guard down. */
function runGuard(g, ticks, shape) {
  let down = 0;
  let firstDownAt = null;
  for (let i = 0; i < ticks; i += 1) {
    g.client.lastInput = shape(i);
    g.match.tick();
    if (i < 12) continue;
    if (!g.player.blocking) {
      down += 1;
      if (firstDownAt === null) firstDownAt = i;
    }
    if (g.player.state === 'swimming') g.player.state = 'alive';
  }
  return { down, firstDownAt, sampled: ticks - 12 };
}

console.log('Held cutlass guard');

// ── 1. Nothing at all changing: the guard never blinks ──
{
  const g = makeGuard('steady');
  const r = runGuard(g, 300, (i) => ({ ...HELD, seq: i + 1 }));
  expect('an unchanging held aim never lowers the guard', r.down === 0,
    `down on ${r.down}/${r.sampled} ticks (first at tick ${r.firstDownAt})`);
  g.match.stop?.();
}

// ── 2. Input seq gaps (a snapshot-starved client replaying one packet) ──
{
  const g = makeGuard('seqgap');
  const r = runGuard(g, 300, () => ({ ...HELD }));
  expect('a client stuck on one input seq keeps its guard up', r.down === 0,
    `down on ${r.down}/${r.sampled} ticks`);
  g.match.stop?.();
}

// ── 3. A packet arriving without the aim bit — the reported flicker ──
{
  const g = makeGuard('jitter');
  const r = runGuard(g, 300, (i) => ({ ...HELD, seq: i + 1, aim: i % 37 !== 0 }));
  expect('a dropped aim bit does not lower a held guard', r.down === 0,
    `down on ${r.down}/${r.sampled} ticks (first at tick ${r.firstDownAt})`);
  g.match.stop?.();
}

// ── 4. A wave flipping a shoreline walker to 'swimming' for one tick ──
{
  const g = makeGuard('swim');
  const r = runGuard(g, 300, (i) => {
    if (i % 41 === 0) g.player.state = 'swimming';
    return { ...HELD, seq: i + 1 };
  });
  expect('a one-tick swim flicker does not lower a held guard', r.down === 0,
    `down on ${r.down}/${r.sampled} ticks (first at tick ${r.firstDownAt})`);
  g.match.stop?.();
}

// ── 5. Genuinely swimming still means no guard (the grace is not a loophole) ──
{
  const g = makeGuard('swimming');
  const r = runGuard(g, 300, (i) => {
    g.player.state = 'swimming';
    return { ...HELD, seq: i + 1 };
  });
  expect('a pirate treading water cannot parry', r.down === r.sampled,
    `guard was up on ${r.sampled - r.down}/${r.sampled} ticks`);
  g.match.stop?.();
}

// ── 6. Letting go drops the guard, and fast ──
{
  const g = makeGuard('release');
  runGuard(g, 60, (i) => ({ ...HELD, seq: i + 1 }));
  expect('the guard is up before release', g.player.blocking === true);
  let ticksDown = 0;
  for (let i = 0; i < 200; i += 1) {
    g.client.lastInput = { ...HELD, seq: 100 + i, aim: false };
    g.match.tick();
    ticksDown += 1;
    if (!g.player.blocking) break;
  }
  expect('releasing the button drops the guard inside the hold grace',
    g.player.blocking === false && ticksDown * DT <= PLAYER.GUARD_HOLD_GRACE + 3 * DT,
    `still blocking=${g.player.blocking} after ${(ticksDown * DT).toFixed(3)}s (grace ${PLAYER.GUARD_HOLD_GRACE}s)`);
  g.match.stop?.();
}

// ── 7. Deliberate drops stay instant ──
// (atCannon / atHelm are unreachable off a ship — clearStationFlags already
//  zeroes both, and the guard with them, on every shipless tick.)
{
  for (const [label, mutate] of [
    ['swinging (fire)', (g, input) => { input.fire = true; }],
    ['mid-swing recovery', (g) => { g.player.weapons[g.player.activeSlot].reloading = true; }],
    ['hands full of treasure', (g) => { g.player.carryingChestId = 'chest-1'; }],
    ['sheathing the cutlass', (g, input) => {
      const other = g.player.weapons.findIndex((w) => w && w.weaponId !== 'cutlass');
      input.slot = other;
      g.player.activeSlot = other;
    }],
  ]) {
    const g = makeGuard(`drop-${label.replace(/\W+/g, '-')}`);
    runGuard(g, 60, (i) => ({ ...HELD, seq: i + 1 }));
    const wasUp = g.player.blocking;
    const input = { ...HELD, seq: 999 };
    mutate(g, input);
    g.client.lastInput = input;
    g.match.tick();
    expect(`${label} drops the guard the same tick`, wasUp && g.player.blocking === false,
      `wasUp=${wasUp} blocking=${g.player.blocking}`);
    g.match.stop?.();
  }
}

if (failures > 0) {
  console.error(`\n${failures} held-guard assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll held-guard assertions passed.');
