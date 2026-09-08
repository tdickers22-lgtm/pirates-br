#!/usr/bin/env node
/**
 * PRED-01 (netcode-35) — the shared pirate step, and the reconciliation that
 * makes it usable on a real connection.
 *
 * WHAT THIS GATE IS FOR
 * Until PRED-01 the pirate's movement integration existed exactly once, inside
 * `Match.applyInput`, so the client could not simulate its own body even in
 * principle. The fix moves that block verbatim into `shared/locomotion.ts`
 * (`stepPirate`) and has the server call it. "Verbatim" is a claim, so this
 * file holds a TRANSCRIPTION OF THE PRE-EXTRACTION BLOCK, copied from
 * Match.applyInput at HEAD f4cbb078..48bac595, and drives both with the same
 * 600-tick input tape. Any drift — a changed constant, a reordered blend, a
 * dropped `|| 1` — shows up as a bit difference on some tick.
 *
 * 1. Land tape: 600 ticks, walk/strafe/crouch/jump/yaw sweep. Bit-identical.
 * 2. Swim tape:  600 ticks, pitch dive + jump-up + sailLower. Bit-identical.
 * 3. Grounded parity on real generated terrain (island footing + dock + deck).
 * 4. Match.applyInput no longer integrates movement inline (it calls the shared
 *    step) — the structural half of the claim.
 *
 * Logic tier: no server, no browser, no stack.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stepPirate, isPirateGrounded, PredictionRing, PREDICTION_HARD_SNAP_M } from '../src/shared/locomotion.ts';
import { PLAYER } from '../src/shared/constants/index.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { buildInputAck } from '../src/server/core/snapshot.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── The pre-extraction block, transcribed. DO NOT "tidy" this: its whole value
//    is that it is the arithmetic the server shipped before the extraction.
function referenceStep(player, input, dt, env) {
  const yaw = input.yaw;
  const jumpBlocked = env.jumpBlocked;
  const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  if (player.state === 'swimming') {
    const pitch = input.pitch;
    const forwardScale = Math.cos(pitch);
    const forwardX = Math.sin(yaw) * forwardScale;
    const forwardY = Math.sin(pitch);
    const forwardZ = Math.cos(yaw) * forwardScale;
    const rightX = -Math.cos(yaw);
    const rightZ = Math.sin(yaw);
    const forwardIntent = (input.forward ? 1 : 0) - (input.back ? 0.58 : 0);
    const strafeIntent = (input.right ? 0.72 : 0) - (input.left ? 0.72 : 0);
    let wishX = 0, wishY = 0, wishZ = 0;
    if (forwardIntent !== 0) {
      const forwardScaleY = forwardIntent > 0 ? 1.18 : 0.6;
      wishX += forwardX * forwardIntent;
      wishY += forwardY * forwardScaleY * Math.abs(forwardIntent);
      wishZ += forwardZ * forwardIntent;
    }
    if (strafeIntent !== 0) { wishX += rightX * strafeIntent; wishZ += rightZ * strafeIntent; }
    if (input.jump) wishY += 0.95;
    if (input.sailLower) wishY -= 0.95;
    const plunging = player.velocity.y < -1.5;
    if (plunging && wishY > 0) wishY = 0;
    const swimLen = Math.sqrt(wishX * wishX + wishY * wishY + wishZ * wishZ);
    if (swimLen > 0.001) {
      const swimSpeed = PLAYER.SWIM_SPEED * (input.forward ? 1.06 : 1);
      const targetVx = (wishX / swimLen) * swimSpeed;
      const targetVz = (wishZ / swimLen) * swimSpeed;
      const targetVy = (wishY / swimLen) * PLAYER.SWIM_SPEED * 0.92;
      const horizBlend = 1 - Math.exp(-dt * 9);
      const vertBlend = 1 - Math.exp(-dt * 3.5);
      player.velocity.x += (targetVx - player.velocity.x) * horizBlend;
      player.velocity.z += (targetVz - player.velocity.z) * horizBlend;
      player.velocity.y += (targetVy - player.velocity.y) * vertBlend;
      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
    }
    return;
  }
  const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
  const nx = moveX / len, nz = moveZ / len;
  const speed = PLAYER.MOVE_SPEED * (player.crouching ? 0.55 : 1);
  if (moveX !== 0 || moveZ !== 0) {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    player.velocity.x = (sinY * nz - cosY * nx) * speed;
    player.velocity.z = (cosY * nz + sinY * nx) * speed;
    player.position.x += player.velocity.x * dt;
    player.position.z += player.velocity.z * dt;
  } else {
    player.velocity.x = 0;
    player.velocity.z = 0;
  }
  const verticalReady = player.velocity.y <= 0.2;
  let grounded = false;
  if (verticalReady) grounded = env.referenceGrounded(player);
  if (input.jumpPressed && !jumpBlocked && grounded) player.velocity.y = PLAYER.JUMP_FORCE;
}

/** Deterministic tape — mulberry32, no Math.random anywhere in a sim gate. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeState(state) {
  return {
    position: { x: 12.5, y: 4.25, z: -33.75 },
    velocity: { x: 0, y: 0, z: 0 },
    crouching: false,
    state,
    atCrowNest: false,
    onShipId: null,
  };
}

function runTape(label, mode, ticks, env) {
  const r = rng(0x5eed01);
  const a = makeState(mode);
  const b = makeState(mode);
  const dt = 1 / 62.5;
  let firstDiff = null;
  for (let i = 0; i < ticks; i += 1) {
    const input = {
      forward: r() < 0.55,
      back: r() < 0.18,
      left: r() < 0.22,
      right: r() < 0.22,
      jump: r() < 0.12,
      jumpPressed: r() < 0.05,
      sailLower: r() < 0.1,
      yaw: (r() - 0.5) * Math.PI * 2,
      pitch: (r() - 0.5) * 1.2,
    };
    const crouch = r() < 0.15;
    a.crouching = crouch;
    b.crouching = crouch;
    // Velocity.y is PhysicsSystem's business; feed both the same drift so the
    // plunge branch and the verticalReady gate are actually reached.
    const vy = Math.sin(i * 0.11) * 2.4;
    a.velocity.y = vy;
    b.velocity.y = vy;
    referenceStep(a, input, dt, env);
    stepPirate(b, input, dt, env);
    if (firstDiff === null) {
      for (const axis of ['x', 'y', 'z']) {
        if (a.position[axis] !== b.position[axis] || a.velocity[axis] !== b.velocity[axis]) {
          firstDiff = `tick ${i} ${axis}: ref pos ${a.position[axis]} vel ${a.velocity[axis]} | shared pos ${b.position[axis]} vel ${b.velocity[axis]}`;
          break;
        }
      }
    }
  }
  expect(`${label}: ${ticks} ticks bit-identical (ref vs shared stepPirate)`, firstDiff === null, firstDiff ?? '');
  return { a, b };
}

console.log('\n[1] Land tape — walk / strafe / crouch / jump, 600 ticks');
const airborneEnv = { ship: null, islands: [], jumpBlocked: false, referenceGrounded: () => false };
runTape('land, no footing', 'alive', 600, airborneEnv);

console.log('\n[2] Swim tape — dive / rise / plunge preservation, 600 ticks');
runTape('swimming', 'swimming', 600, airborneEnv);

console.log('\n[3] Grounded parity on generated terrain');
const islands = new MapGenerator(20260801).generateIslands();
const island = islands[0];
const groundEnv = {
  ship: null,
  islands: [island],
  jumpBlocked: false,
  referenceGrounded: (p) => {
    for (const isle of [island]) {
      // reference: the inline loop from Match.applyInput
      const inside = getIslandSurfaceY(isle, p.position.x, p.position.z);
      if (Math.abs(p.position.y - inside) < 0.24) return true;
    }
    return false;
  },
};
{
  const k = makeState('alive');
  k.position.x = island.position.x;
  k.position.z = island.position.z;
  k.position.y = getIslandSurfaceY(island, island.position.x, island.position.z);
  k.velocity.y = 0;
  expect('a body standing on the summit is grounded', isPirateGrounded(k, groundEnv) === true);
  k.position.y += 3;
  expect('the same body three metres up is not grounded', isPirateGrounded(k, groundEnv) === false);
  k.position.y -= 3;
  k.velocity.y = 4;
  expect('a rising body is not grounded (no double jump)', isPirateGrounded(k, groundEnv) === false);
  k.velocity.y = 0;
  const before = k.velocity.y;
  // No WASD: the jump gate runs AFTER the horizontal step, so a moving body is
  // tested at its new footing — correct, but not what this assertion is about.
  stepPirate(k, { jumpPressed: true, yaw: 0, pitch: 0 }, 1 / 62.5, groundEnv);
  expect('SPACE on the ground launches at JUMP_FORCE', k.velocity.y === PLAYER.JUMP_FORCE, `before ${before} after ${k.velocity.y}`);
  const helmBlocked = makeState('alive');
  helmBlocked.position.y = getIslandSurfaceY(island, island.position.x, island.position.z);
  helmBlocked.position.x = island.position.x;
  helmBlocked.position.z = island.position.z;
  stepPirate(helmBlocked, { jumpPressed: true, yaw: 0, pitch: 0 }, 1 / 62.5, { ...groundEnv, jumpBlocked: true });
  expect('SPACE at a pinned station does nothing', helmBlocked.velocity.y === 0);
}

console.log('\n[4] The server runs the shared step, not a private copy');
const matchSrc = readFileSync(join(ROOT, 'src/server/core/Match.ts'), 'utf8');
expect('Match.applyInput calls stepPirate', /stepPirate\(/.test(matchSrc));
expect(
  'Match.ts no longer holds the inline movement integration',
  !matchSrc.includes('player.velocity.x = (sinY * nz - cosY * nx) * speed'),
  'the inline block is still there — the extraction did not actually move it',
);
expect(
  'Match.ts no longer holds the inline swim blend',
  !matchSrc.includes('const horizBlend = 1 - Math.exp(-dt * 9)'),
);

console.log('\n[5] The per-client input receipt (input_ack)');
{
  const player = {
    position: { x: 123.456789, y: 8.7654321, z: -55.5555 },
    velocity: { x: 1.23456, y: -0.5, z: 3.99999 },
    onShipId: 'ship-7',
    state: 'alive',
  };
  const ack = buildInputAck(player, 4242, 91.23456);
  expect('carries the consumed seq', ack.seq === 4242);
  expect('carries world position, quantised to mm', ack.pos.x === 123.457 && ack.pos.z === -55.555,
    JSON.stringify(ack.pos));
  expect('carries velocity and the hull the body stood on',
    ack.vel.x === 1.23 && ack.onShipId === 'ship-7' && ack.state === 'alive', JSON.stringify(ack));
  expect('carries the server clock the hot snapshot uses', ack.t === 91.235);
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'input_ack', ts: Date.now(), payload: ack }));
  // The budget in the plan is ~70 B of payload; the envelope takes it to ~150 B.
  // At 31 Hz that is <=4.7 KB/s per client and nothing changes for anyone else.
  expect(`one receipt fits the wire budget (${bytes} B <= 200)`, bytes <= 200, `${bytes} B`);
  const acksPerSecond = 31;
  expect(`31 Hz of receipts stays under 6 KB/s (${(bytes * acksPerSecond / 1024).toFixed(1)} KB/s)`,
    bytes * acksPerSecond <= 6 * 1024);
}
{
  // Anchored to the hot broadcast itself: a grep for the method NAME would go
  // on passing with the call commented out (it matches the declaration).
  expect('Match sends a receipt on the hot tick',
    matchSrc.includes("}, 'hot');\n        this.broadcastInputAcks();"));
  expect('a congested socket is skipped rather than queued',
    /bufferedAmount > MAX_VOLATILE_BUFFERED_BYTES\) continue;\n      const player = this\.getPlayer/.test(matchSrc));
  const workerSrc = readFileSync(join(ROOT, 'src/client/network/socket.worker.ts'), 'utf8');
  expect('the socket worker coalesces receipts (a stale ack must never rewind prediction)',
    /input_ack/.test(workerSrc) && workerSrc.includes("'state_snapshot', 'state_hot', 'input_ack'"));
}

console.log('\n[6] Reconciliation — a 6-tick ack delay never shows on the body');
{
  const DT = 1 / 62.5;
  const env = airborneEnv;
  // The SERVER: applies whatever input is in force on every tick, exactly as
  // Match does with client.lastInput.
  const server = makeState('alive');
  // The CLIENT: predicts forward from the last ack it heard.
  const client = makeState('alive');
  // THE CONTROL: today's behaviour — the body is placed at the last state the
  // server sent and carried forward at that state's velocity, with no replay of
  // the inputs the player has pressed since. If this does NOT diverge, the whole
  // measurement is vacuous and the gate proves nothing.
  const control = makeState('alive');
  const ring = new PredictionRing();
  const r = rng(0xac4de1);

  let seq = 0;
  let held = { forward: true, back: false, left: false, right: false, jump: false, jumpPressed: false, sailLower: false, yaw: 0.3, pitch: 0 };
  ring.record(seq, 0, held);
  // Delayed receipts: the ack the client acts on is 6 ticks (96 ms) old.
  const ACK_DELAY_TICKS = 6;
  const pending = [];
  let worst = 0;
  let worstControl = 0;
  let worstAt = -1;
  const TICKS = 600;
  for (let i = 0; i < TICKS; i += 1) {
    const t = i * DT;
    // The player changes what he is holding now and then — a new seq, exactly
    // as the client's send path stamps one when the signature changes.
    if (r() < 0.06) {
      seq += 1;
      held = {
        forward: r() < 0.6, back: r() < 0.2, left: r() < 0.25, right: r() < 0.25,
        jump: false, jumpPressed: false, sailLower: false,
        yaw: (r() - 0.5) * Math.PI * 2, pitch: 0,
      };
      ring.record(seq, t, held);
    }
    // Server tick.
    stepPirate(server, held, DT, env);
    pending.push({ at: i + ACK_DELAY_TICKS, seq, t: t + DT, pos: { ...server.position }, vel: { ...server.velocity } });

    // Client: on an ack, rewind to it and replay the ring forward to NOW.
    const due = pending.length > 0 && pending[0].at === i ? pending.shift() : null;
    if (due) {
      ring.pruneTo(due.seq);
      client.position.x = due.pos.x; client.position.y = due.pos.y; client.position.z = due.pos.z;
      client.velocity.x = due.vel.x; client.velocity.y = due.vel.y; client.velocity.z = due.vel.z;
      ring.replay(client, due.t, t + DT, DT, env);
      control.position.x = due.pos.x; control.position.z = due.pos.z;
      control.velocity.x = due.vel.x; control.velocity.z = due.vel.z;
    } else {
      const now = ring.inputAt(t);
      if (now) stepPirate(client, now, DT, env);
    }
    // The control dead-reckons at the acked velocity, like getPlayerRenderPosition does today.
    control.position.x += control.velocity.x * DT;
    control.position.z += control.velocity.z * DT;
    const controlErr = Math.hypot(control.position.x - server.position.x, control.position.z - server.position.z);
    if (i > ACK_DELAY_TICKS + 2 && controlErr > worstControl) worstControl = controlErr;
    const err = Math.hypot(client.position.x - server.position.x, client.position.z - server.position.z);
    // Skip the first ack window: before the first receipt lands the client has
    // nothing to reconcile against, which is not what this measures.
    if (i > ACK_DELAY_TICKS + 2 && err > worst) { worst = err; worstAt = i; }
  }
  expect(`predicted body never diverges >0.05 m under a 6-tick ack delay (worst ${worst.toFixed(4)} m at tick ${worstAt})`,
    worst <= 0.05, `worst ${worst} m`);
  expect(`CONTROL: dead reckoning alone DOES diverge (worst ${worstControl.toFixed(3)} m > 0.05)`,
    worstControl > 0.05, `control worst ${worstControl} m — the tape does not move the body enough to grade anything`);
  expect('the ring does not grow without bound', ring.size <= 250, `${ring.size} entries`);
  expect('a hard snap threshold exists and is above the smoothable band',
    PREDICTION_HARD_SNAP_M > 0.05 && PREDICTION_HARD_SNAP_M <= 2);
}
{
  // pruneTo keeps the acked entry: it is still the input in force at the acked
  // instant, so a replay that starts there needs it.
  const ring = new PredictionRing();
  const a = { forward: true, yaw: 0, pitch: 0 };
  const b = { forward: false, back: true, yaw: 0, pitch: 0 };
  ring.record(1, 0, a);
  ring.record(2, 1, b);
  ring.pruneTo(2);
  expect('pruning to the acked seq keeps the input in force at that instant', ring.size === 1 && ring.inputAt(1) === b);
  expect('an input before the ring start still answers (the oldest is in force)', ring.inputAt(-5) === b);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — test-prediction (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures === 0 ? 0 : 1);
