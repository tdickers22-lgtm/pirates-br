// Numerical simulation of water entry — validates that a player launched from
// a cannon (or jumping into water) actually plunges below the surface and rises
// back, instead of getting snapped to the surface.

const PHYSICS_GRAVITY = -18;
const SWIM_MAX_DEPTH = 42;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Mirrors src/server/systems/PhysicsSystem.ts swim block + cannon-ballistic landing.
// `entryVel` is the velocity AT the moment of water entry (already damped 0.7 by the
// server's ballistic-landing branch — the simulation applies that damping itself).
function simulate({ entryVel, dt = 1 / 60, durationS = 4 }) {
  let pos = { x: 0, y: 0.32 /* exactly at the water surface */, z: 0 };
  let vel = { ...entryVel };
  // Start in 'swimming' state — entry damping is applied by the cannon-landing branch
  vel.x *= 0.65;
  vel.y *= 0.7;
  vel.z *= 0.65;
  let state = 'swimming';
  const waveY = 0;
  const surfaceY = waveY + 0.32;
  const log = [];

  const steps = Math.ceil(durationS / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;

    if (state === 'swimming') {
      const maxBreachHeight = waveY + 0.86;
      const depthBelowSurface = Math.max(0, surfaceY - pos.y);
      const buoyancyScale = depthBelowSurface > 12
        ? 0.22
        : depthBelowSurface > 4
          ? 0.42
          : 0.6;
      const maxLift = depthBelowSurface > 12 ? 2.4 : 2.8;
      const buoyancy = clamp((surfaceY - pos.y) * buoyancyScale, -2.0, maxLift);
      vel.y += buoyancy * dt;
      const yDamp = Math.pow(0.55, dt);
      const xzDamp = Math.pow(0.5, dt);
      vel.x *= xzDamp;
      vel.y *= yDamp;
      vel.z *= xzDamp;
      pos.y += vel.y * dt;
      if (pos.y < waveY - SWIM_MAX_DEPTH) {
        pos.y = waveY - SWIM_MAX_DEPTH;
        if (vel.y < 0) vel.y *= -0.08;
      }
      if (pos.y > maxBreachHeight && vel.y >= 0) {
        pos.y = maxBreachHeight;
        vel.y *= 0.12;
      }
      log.push({ t, y: pos.y, vy: vel.y, state });

    }
  }

  let minY = Infinity;
  let minYTime = 0;
  let surfacedAt = null;
  let plungeStartTime = null;
  for (const entry of log) {
    if (entry.state === 'swimming') {
      if (plungeStartTime === null) plungeStartTime = entry.t;
      if (entry.y < minY) {
        minY = entry.y;
        minYTime = entry.t;
      }
      if (surfacedAt === null && minY < -0.2 && entry.y > -0.3) {
        surfacedAt = entry.t;
      }
    }
  }

  return { minY, minYTime, surfacedAt, plungeStartTime, finalY: log[log.length - 1].y };
}

function simulateNormalFall({ startY, entryVel, dt = 1 / 60, durationS = 5 }) {
  let pos = { x: 0, y: startY, z: 0 };
  let vel = { ...entryVel };
  let state = 'alive';
  const waveY = 0;
  const surfaceY = waveY + 0.32;
  const log = [];

  const steps = Math.ceil(durationS / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const alreadySwimming = state === 'swimming';
    if (!alreadySwimming && pos.y > surfaceY) {
      vel.y += PHYSICS_GRAVITY * dt;
      pos.y += vel.y * dt;
    } else {
      if (!alreadySwimming) {
        vel.x *= 0.78;
        vel.z *= 0.78;
        if (vel.y < 0) vel.y *= 0.90;
      }
      state = 'swimming';

      const maxBreachHeight = waveY + 0.86;
      const depthBelowSurface = Math.max(0, surfaceY - pos.y);
      const buoyancyScale = depthBelowSurface > 12
        ? 0.22
        : depthBelowSurface > 4
          ? 0.42
          : 0.6;
      const maxLift = depthBelowSurface > 12 ? 2.4 : 2.8;
      const buoyancy = clamp((surfaceY - pos.y) * buoyancyScale, -2.0, maxLift);
      vel.y += buoyancy * dt;
      const yDamp = Math.pow(0.55, dt);
      const xzDamp = Math.pow(0.5, dt);
      vel.x *= xzDamp;
      vel.y *= yDamp;
      vel.z *= xzDamp;
      pos.y += vel.y * dt;
      if (pos.y < waveY - SWIM_MAX_DEPTH) {
        pos.y = waveY - SWIM_MAX_DEPTH;
        if (vel.y < 0) vel.y *= -0.08;
      }
      if (pos.y > maxBreachHeight && vel.y >= 0) {
        pos.y = maxBreachHeight;
        vel.y *= 0.12;
      }
    }
    log.push({ t, y: pos.y, vy: vel.y, state });
  }

  let minY = Infinity;
  let firstSwimY = null;
  for (const entry of log) {
    if (entry.y < minY) minY = entry.y;
    if (firstSwimY === null && entry.state === 'swimming') firstSwimY = entry.y;
  }

  return { minY, firstSwimY, finalY: log[log.length - 1].y };
}

// Simulates the full server pipeline: applyInput (swim block) + PhysicsSystem swim
// physics. This catches regressions where applyInput zeroes plunge momentum even
// when no input is held — the historical "slap-don't-plunge" bug.
function simulateWithInputPipeline({ entryVel, dt = 1 / 60, durationS = 4, holdJump = false }) {
  let pos = { x: 0, y: 0.32, z: 0 };
  let vel = { ...entryVel };
  vel.x *= 0.65; vel.y *= 0.7; vel.z *= 0.65;
  const SWIM_SPEED = 5.2;
  const waveY = 0;
  const surfaceY = waveY + 0.32;
  const log = [];

  const steps = Math.ceil(durationS / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;

    // === applyInput swim block ===
    let wishX = 0, wishY = 0, wishZ = 0;
    if (holdJump) wishY += 0.95;
    if (vel.y < -1.5 && wishY > 0) wishY = 0; // plunge protection
    const swimLen = Math.sqrt(wishX * wishX + wishY * wishY + wishZ * wishZ);
    if (swimLen > 0.001) {
      const targetVy = (wishY / swimLen) * SWIM_SPEED * 0.92;
      const vertBlend = 1 - Math.exp(-dt * 3.5);
      vel.y += (targetVy - vel.y) * vertBlend;
    }
    // No-input branch: intentionally do NOT damp velocity.

    // === PhysicsSystem swim block ===
    const maxBreachHeight = waveY + 0.86;
    const depthBelowSurface = Math.max(0, surfaceY - pos.y);
      const buoyancyScale = depthBelowSurface > 12 ? 0.22 : depthBelowSurface > 4 ? 0.42 : 0.6;
      const maxLift = depthBelowSurface > 12 ? 2.4 : 2.8;
      const buoyancy = clamp((surfaceY - pos.y) * buoyancyScale, -2.0, maxLift);
      vel.y += buoyancy * dt;
      vel.x *= Math.pow(0.5, dt);
      vel.y *= Math.pow(0.55, dt);
      vel.z *= Math.pow(0.5, dt);
    pos.y += vel.y * dt;
    if (pos.y > maxBreachHeight && vel.y >= 0) { pos.y = maxBreachHeight; vel.y *= 0.12; }
    log.push({ t, y: pos.y, vy: vel.y });
  }

  let minY = Infinity;
  let minYTime = 0;
  for (const e of log) if (e.y < minY) { minY = e.y; minYTime = e.t; }
  return { minY, minYTime, finalY: log[log.length - 1].y };
}

function assert(cond, msg) {
  if (!cond) {
    console.error('  ✗', msg);
    process.exitCode = 1;
  } else {
    console.log('  ✓', msg);
  }
}

console.log('Water entry plunge physics');

// Scenario 1: cannon launch landing at -8 m/s vertical, 4 m/s horizontal
{
  const r = simulate({ entryVel: { x: 4, y: -8, z: 0 }, durationS: 6 });
  console.log('  cannon land (-8m/s):', `min depth ${r.minY.toFixed(2)}m at t=${r.minYTime.toFixed(2)}s, final ${r.finalY.toFixed(2)}m`);
  assert(r.minY < -1.5, `Plunged at least 1.5m below surface (got ${r.minY.toFixed(2)})`);
  assert(r.minYTime > 0.1, `Plunge takes a moment (got ${r.minYTime.toFixed(2)}s)`);
  assert(r.finalY > -0.6 && r.finalY < 1.0, `Eventually returns near surface (got ${r.finalY.toFixed(2)}m)`);
}

// Scenario 2: high cannon arc landing at -14 m/s
{
  const r = simulate({ entryVel: { x: 6, y: -14, z: 0 }, durationS: 6 });
  console.log('  hard land   (-14m/s):', `min depth ${r.minY.toFixed(2)}m at t=${r.minYTime.toFixed(2)}s, final ${r.finalY.toFixed(2)}m`);
  assert(r.minY < -3.0, `Hard landing plunges deeper (got ${r.minY.toFixed(2)})`);
  assert(r.finalY > -0.6 && r.finalY < 1.0, `Returns near surface (got ${r.finalY.toFixed(2)}m)`);
}

// Scenario 3: gentle drop from a low jump (-3 m/s)
{
  const r = simulate({ entryVel: { x: 1, y: -3, z: 0 } });
  console.log('  gentle drop (-3m/s):', `min depth ${r.minY.toFixed(2)}m, final ${r.finalY.toFixed(2)}m`);
  assert(r.minY < -0.4, `Even gentle entry dips noticeably (got ${r.minY.toFixed(2)})`);
}

// Scenario 4: ordinary dock/ledge fall must stay airborne until actual water contact.
{
  const r = simulateNormalFall({ startY: 4.0, entryVel: { x: 1.5, y: 0, z: 0 } });
  console.log('  normal fall:', `first swim y ${r.firstSwimY?.toFixed(2)}m, min depth ${r.minY.toFixed(2)}m`);
  assert((r.firstSwimY ?? 99) <= 0.32, `Swimming begins at or below waterline (got ${r.firstSwimY?.toFixed(2)})`);
  assert(r.minY < -1.0, `Normal fall plunges below surface (got ${r.minY.toFixed(2)})`);
}

// Scenario 5: full pipeline (applyInput + physics) without any input held — must plunge
{
  const r = simulateWithInputPipeline({ entryVel: { x: 4, y: -8, z: 0 }, durationS: 6 });
  console.log('  full pipe   (no input):', `min depth ${r.minY.toFixed(2)}m at t=${r.minYTime.toFixed(2)}s, final ${r.finalY.toFixed(2)}m`);
  assert(r.minY < -1.5, `Pipeline plunge: at least 1.5m below surface (got ${r.minY.toFixed(2)})`);
  assert(r.finalY > -0.6 && r.finalY < 1.0, `Pipeline plunge: returns near surface (got ${r.finalY.toFixed(2)})`);
}

// Scenario 6: full pipeline with jump held — should still plunge before rising
{
  const r = simulateWithInputPipeline({ entryVel: { x: 4, y: -8, z: 0 }, durationS: 6, holdJump: true });
  console.log('  full pipe   (jump held):', `min depth ${r.minY.toFixed(2)}m at t=${r.minYTime.toFixed(2)}s`);
  assert(r.minY < -0.8, `Even with jump held, plunge happens (got ${r.minY.toFixed(2)})`);
}

if (process.exitCode !== 1) {
  console.log('\nAll water entry assertions passed.');
}
