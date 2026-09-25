#!/usr/bin/env node
// Player locomotion on terrain v2 — drives the REAL PhysicsSystem over generated
// islands (MapGenerator) so the shared terrain heightfield, cave volumes and prop
// colliders exercise the same code the match server runs at 62.5 Hz.
//
// Coverage:
//  1. Beach water entry: monotonic descent, exactly one alive→swimming transition,
//     hysteresis (round-trip has no state flapping).
//  2. Archipelago saddle: a submerged interior saddle forces swimming, land does not.
//  3. Cave ceiling clamps a jump; a walker ABOVE the cave stays on the natural surface.
//  4. Prop collider (palm) blocks a straight-line walk with no tunneling.
//  5. Steep slope blocks an ascent (jumping unaffected — this is the grounded case).
//  6. Fall damage: a cliff-height plunge into deep water deals 0 damage, while the
//     same drop onto hard ground hurts (proves water entry cancels fall damage).
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PLAYER, SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  getIslandSurfaceY,
  getIslandMaxRadius,
  getCaveCeilingY,
  getCaveFloorY,
  getIslandCoastType,
  isSubmergedAt,
  isPointInsideIslandFootprint,
  gerstnerHeight,
  WAVE_PARAMS,
  getIslandDistRatio,
} from '../src/shared/utils/index.ts';
import { PROP_COLLIDERS } from '../src/shared/props.ts';
import { stepPirate } from '../src/shared/locomotion.ts';
import { stormSeaState } from '../src/server/systems/PhysicsSystem.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 62.5;
const T = 0; // fixed sim time → deterministic Gerstner surface

function angleDelta(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function makePlayer(position, overrides = {}) {
  return {
    id: 'loco-tester',
    name: 'Tester',
    shipId: null,
    position: { ...position },
    rotation: { x: 0, y: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH,
    state: 'alive',
    weapons: [],
    activeSlot: 0,
    reloading: false,
    reloadTimer: 0,
    knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: false,
    kills: 0,
    playerKillStreak: 0,
    superCannonballs: 0,
    megaKegs: 0,
    tsunamiCharges: 0,
    gold: 0,
    carryingChestId: null,
    treasureMapIslandId: null,
    swimTimer: 0,
    atCannon: false,
    atHelm: false,
    sailControlMode: null,
    atCrowNest: false,
    blocking: false,
    cutlassCharge: 0,
    cannonIndex: 0,
    nearChestId: null,
    nearShipId: null,
    onShipId: null,
    respawnTimer: 0,
    respawnProtectionTimer: 0,
    shipBoundaryGraceTimer: 0,
    lastDamagedById: null,
    lastDamagedAt: null,
    lastDamageWasHeadshot: false,
    selectedCannonAmmo: 'cannonball',
    kegs: 0,
    kegCooldown: 0,
    cannonFlightTimer: 0,
    cannonBallistic: false,
    pocketBanana: 0,
    pocketWood: 0,
    pocketCoconut: 0,
    pocketMango: 0,
    pocketMeat: 0,
    pocketUseCooldown: 0,
    hasShovel: false,
    nearBarrelId: null,
    ...overrides,
  };
}

/** One tick: mimic Match.applyInput's horizontal walk (velocity → position), then
 *  run the authoritative physics step. `dir` null ⇒ no input (pure physics). */
function step(physics, player, islands, dir) {
  if (dir) {
    player.velocity.x = dir.x;
    player.velocity.z = dir.z;
    player.position.x += player.velocity.x * DT;
    player.position.z += player.velocity.z * DT;
  }
  physics.update(DT, T, [], [player], [], islands, []);
}

// ── Build a pool of real islands across several seeds so every feature exists ──
const POOL = [];
for (const seed of [101, 202, 303, 404, 505]) {
  POOL.push(...new MapGenerator(seed).generateIslands());
}

console.log('Player locomotion (terrain v2)');

// ── 1. Beach water entry ─────────────────────────────────────────────────────
{
  const beach = findBeachRay(POOL);
  expect('Found a beach coast that slopes underwater', beach !== null);
  if (beach) {
    const { island, dir } = beach;
    const physics = new PhysicsSystem();
    const startY = getIslandSurfaceY(island, beach.start.x, beach.start.z);
    const player = makePlayer({ x: beach.start.x, y: startY, z: beach.start.z }, { respawnProtectionTimer: 0 });
    // Prime last-tick footing (stationary frame).
    step(physics, player, [island], null);

    const out = walkUntil(physics, player, [island], dir, (p) => p.state === 'swimming', 150, 4000);
    const inLeg = walkUntil(physics, player, [island], { x: -dir.x, z: -dir.z }, (p) => p.state === 'alive', 100, 6000);
    const seq = [...out, ...inLeg];

    let a2s = 0;
    let s2a = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i - 1].state === 'alive' && seq[i].state === 'swimming') a2s += 1;
      if (seq[i - 1].state === 'swimming' && seq[i].state === 'alive') s2a += 1;
    }
    expect('Beach walk-in: exactly one alive→swimming transition', a2s === 1, `a2s=${a2s}`);
    expect('Round trip: exactly one swimming→alive transition (hysteresis, no flapping)', s2a === 1, `s2a=${s2a}`);

    // Monotonic descent across the alive walking phase of the out leg.
    const aliveOut = [];
    for (const f of out) {
      if (f.state !== 'alive') break; // first swimming frame ends the walking phase
      aliveOut.push(f.y);
    }
    let monotonic = true;
    for (let i = 1; i < aliveOut.length; i++) {
      if (aliveOut[i] > aliveOut[i - 1] + 0.05) { monotonic = false; break; }
    }
    const descent = aliveOut.length > 1 ? aliveOut[0] - aliveOut[aliveOut.length - 1] : 0;
    expect('Beach walk-in: y descends monotonically while alive', monotonic && aliveOut.length > 3, `frames=${aliveOut.length}`);
    expect('Beach walk-in: a real descent occurs before swimming (>1m)', descent > 1.0, `descent=${descent.toFixed(2)}m`);
    // First swimming frame must not be higher than the last alive frame (smooth, no teleport up).
    const firstSwim = out.find((f) => f.state === 'swimming');
    const lastAlive = aliveOut[aliveOut.length - 1];
    expect('Beach walk-in: swim begins at or below the last footing (no teleport)', firstSwim && firstSwim.y <= lastAlive + 0.05, `swimY=${firstSwim?.y.toFixed(2)} lastAlive=${lastAlive.toFixed(2)}`);
  }
}

// ── 2. Archipelago saddle ────────────────────────────────────────────────────
{
  const found = findSaddle(POOL);
  expect('Found an archipelago island with a submerged saddle + dry land', found !== null);
  if (found) {
    const { island, saddle, land } = found;
    // Saddle: standing on the submerged seabed as 'alive' must flip to swimming.
    const physics = new PhysicsSystem();
    const groundY = getIslandSurfaceY(island, saddle.x, saddle.z);
    const swimmer = makePlayer({ x: saddle.x, y: groundY, z: saddle.z }, { state: 'alive' });
    for (let i = 0; i < 12; i++) step(physics, swimmer, [island], null);
    expect('Saddle: crossing a submerged saddle forces swimming (not seabed-walking)', swimmer.state === 'swimming', `state=${swimmer.state}`);

    // Dry land on the same island must keep the player walking.
    const physics2 = new PhysicsSystem();
    const landY = getIslandSurfaceY(island, land.x, land.z);
    const walker = makePlayer({ x: land.x, y: landY, z: land.z }, { state: 'alive' });
    for (let i = 0; i < 12; i++) step(physics2, walker, [island], null);
    expect('Saddle island: a dry sub-peak keeps the player alive/walking', walker.state === 'alive', `state=${walker.state}`);
  }
}

// ── 3. Cave ceiling clamp + above-cave walker ────────────────────────────────
{
  const found = findCave(POOL);
  expect('Found a dry walkable cave volume', found !== null);
  if (found) {
    const { island, cave, mid } = found;
    const ceilingY = getCaveCeilingY(island, mid.x, mid.z);
    expect('Cave ceiling helper returns a height at the tunnel interior', ceilingY !== null, `ceilingY=${ceilingY}`);

    // Jump inside the cave — a strong upward launch must never punch the head
    // through the roof. Stand on the RAMPED floor at the midpoint (caves descend).
    const floorAtMid = getCaveFloorY(island, mid.x, mid.z);
    const physics = new PhysicsSystem();
    const inside = makePlayer({ x: mid.x, y: floorAtMid, z: mid.z }, { state: 'alive', velocity: { x: 0, y: 12, z: 0 } });
    let maxHead = -Infinity;
    for (let i = 0; i < 40; i++) {
      step(physics, inside, [island], null);
      maxHead = Math.max(maxHead, inside.position.y + PLAYER.HEIGHT);
    }
    const wouldOvershoot = floorAtMid + (12 * 12) / (2 * 18) + PLAYER.HEIGHT; // free-flight head apex
    expect('Cave jump would overshoot the roof without a clamp (precondition)', wouldOvershoot > ceilingY + 0.3, `apex=${wouldOvershoot.toFixed(2)} ceiling=${ceilingY.toFixed(2)}`);
    expect('Cave ceiling clamps a jump (head stays under the roof)', maxHead <= ceilingY + 0.05, `maxHead=${maxHead.toFixed(2)} ceiling=${ceilingY.toFixed(2)}`);

    // Walker standing on the natural hillside ABOVE the cave stays on the surface (no fall into the trench).
    const physics2 = new PhysicsSystem();
    const naturalY = getIslandSurfaceY(island, mid.x, mid.z);
    const above = makePlayer({ x: mid.x, y: naturalY, z: mid.z }, { state: 'alive' });
    for (let i = 0; i < 30; i++) step(physics2, above, [island], null);
    expect('Above-cave walker rests on the natural surface', Math.abs(above.position.y - naturalY) < 0.2, `y=${above.position.y.toFixed(2)} natural=${naturalY.toFixed(2)}`);
    expect('Above-cave walker does NOT fall into the cave trench', above.position.y > ceilingY + 1.0, `y=${above.position.y.toFixed(2)} ceiling=${ceilingY.toFixed(2)}`);
  }
}

// ── 4. Prop collider blocks a straight-line walk ─────────────────────────────
{
  const found = findIsolatedPalm(POOL);
  expect('Found an isolated palm to walk into', found !== null);
  if (found) {
    const { island, palm } = found;
    const col = PROP_COLLIDERS[palm.type];
    const blockR = col.radius * palm.scale + PLAYER.RADIUS;
    // Approach radially outward (start on the inland side, walk toward/through the trunk).
    const ax = palm.x - island.position.x;
    const az = palm.z - island.position.z;
    const al = Math.hypot(ax, az) || 1;
    const dir = { x: (ax / al) * PLAYER.MOVE_SPEED, z: (az / al) * PLAYER.MOVE_SPEED };
    const startX = palm.x - (ax / al) * (blockR + 1.2);
    const startZ = palm.z - (az / al) * (blockR + 1.2);
    const physics = new PhysicsSystem();
    const player = makePlayer({ x: startX, y: getIslandSurfaceY(island, startX, startZ), z: startZ }, { state: 'alive' });
    step(physics, player, [island], null); // prime footing

    let minDist = Infinity;
    let reached = Infinity;
    for (let i = 0; i < 130; i++) {
      step(physics, player, [island], dir);
      const d = Math.hypot(player.position.x - palm.x, player.position.z - palm.z);
      minDist = Math.min(minDist, d);
      reached = Math.min(reached, d);
    }
    // Never tunnelled inside the trunk collider.
    expect('Palm blocks a straight-line walk (no penetration into the collider)', minDist >= blockR - 0.05, `minDist=${minDist.toFixed(3)} blockR=${blockR.toFixed(3)}`);
    // Actually pressed up against the trunk (proves the block is real).
    expect('Player reaches and is stopped by the trunk', reached <= blockR + 0.25, `reached=${reached.toFixed(3)} blockR=${blockR.toFixed(3)}`);
    // Stayed on the inland (near) side — did not pass through to the far side.
    const progress = (player.position.x - palm.x) * (ax / al) + (player.position.z - palm.z) * (az / al);
    expect('Player never tunnels to the far side of the trunk', progress < 0.15, `progress=${progress.toFixed(3)}`);
  }
}

// ── 5. Steep slope blocks an ascent ──────────────────────────────────────────
{
  const found = findSteepAscent(POOL);
  expect('Found a cliff-steep ascent (rise/run > 1.7)', found !== null);
  if (found) {
    const { island, at, up, slope } = found;
    const physics = new PhysicsSystem();
    const startY = getIslandSurfaceY(island, at.x, at.z);
    const player = makePlayer({ x: at.x, y: startY, z: at.z }, { state: 'alive' });
    step(physics, player, [island], null); // prime footing at the base
    const baseX = player.position.x;
    const baseZ = player.position.z;

    const dir = { x: up.x * PLAYER.MOVE_SPEED, z: up.z * PLAYER.MOVE_SPEED };
    for (let i = 0; i < 90; i++) step(physics, player, [island], dir);

    const advanced = Math.hypot(player.position.x - baseX, player.position.z - baseZ);
    const climbed = getIslandSurfaceY(island, player.position.x, player.position.z) - startY;
    expect('Steep slope blocks a walking ascent (barely advances)', advanced < 0.35, `advanced=${advanced.toFixed(3)}m slope=${slope.toFixed(2)}`);
    expect('Steep slope: the player does not climb the cliff face', climbed < 0.6, `climbed=${climbed.toFixed(3)}m`);
  }
}

// ── 6. Fall damage: deep-water plunge = 0, hard-ground plunge hurts ───────────
{
  const open = findOpenSea(POOL);
  expect('Found open sea far from every island', open !== null);
  if (open) {
    const physics = new PhysicsSystem();
    // ~10 m cliff-height plunge with a little forward momentum into deep water.
    const diver = makePlayer({ x: open.x, y: 10, z: open.z }, { state: 'alive', velocity: { x: 3, y: 1.5, z: 0 } });
    for (let i = 0; i < 300; i++) step(physics, diver, POOL, null);
    expect('Cliff jump into deep water deals 0 fall damage', diver.health === PLAYER.MAX_HEALTH, `health=${diver.health}`);
    expect('Cliff jump into deep water ends swimming', diver.state === 'swimming', `state=${diver.state}`);
  }

  const dry = findDryHighGround(POOL);
  expect('Found solid dry high ground for a hard landing', dry !== null);
  if (dry) {
    const { island, at } = dry;
    const physics = new PhysicsSystem();
    const groundY = getIslandSurfaceY(island, at.x, at.z);
    // Drop from ~25 m straight down onto hard ground.
    const faller = makePlayer({ x: at.x, y: groundY + 25, z: at.z }, { state: 'alive' });
    for (let i = 0; i < 200; i++) step(physics, faller, [island], null);
    expect('Landed on the hard ground', Math.abs(faller.position.y - groundY) < 0.4, `y=${faller.position.y.toFixed(2)} ground=${groundY.toFixed(2)}`);
    expect('Hard-ground plunge deals fall damage (so water entry genuinely cancels it)', faller.health < PLAYER.MAX_HEALTH, `health=${faller.health}`);
    expect('Hard-ground fall damage is not instantly lethal from a single cliff', faller.health > 0, `health=${faller.health}`);
  }
}

// ── Fixture finders ──────────────────────────────────────────────────────────
function walkUntil(physics, player, islands, dir, done, extraFrames, maxFrames) {
  const log = [];
  let sinceDone = -1;
  for (let i = 0; i < maxFrames; i++) {
    step(physics, player, islands, dir);
    log.push({ y: player.position.y, state: player.state });
    if (sinceDone < 0 && done(player)) sinceDone = 0;
    if (sinceDone >= 0) {
      sinceDone += 1;
      if (sinceDone >= extraFrames) break;
    }
  }
  return log;
}

function findBeachRay(pool) {
  for (const island of pool) {
    const maxR = getIslandMaxRadius(island);
    for (let ai = 0; ai < 240; ai++) {
      const a = (ai / 240) * Math.PI * 2;
      if (getIslandCoastType(island, a) !== 'beach') continue;
      if (island.dock && Math.abs(angleDelta(a, island.dock.shoreAngle)) < 0.6) continue;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const samples = [];
      for (let r = maxR * 0.4; r <= maxR * 1.5; r += 0.4) {
        const x = island.position.x + dx * r;
        const z = island.position.z + dz * r;
        samples.push({ r, x, z, y: getIslandSurfaceY(island, x, z) });
      }
      // Start high on the dry beach (first point at/under 3.2m but still ≥1.6m)
      // so the walk has a full, monotonic descent to the waterline to measure.
      let startI = -1;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].y <= 3.2 && samples[i].y >= 1.6) { startI = i; break; }
      }
      if (startI < 0) continue;
      let ok = true;
      let deep = false;
      let prevY = samples[startI].y;
      for (let i = startI + 1; i < samples.length; i++) {
        if (samples[i].y > prevY + 0.05) { ok = false; break; }
        prevY = samples[i].y;
        if (samples[i].y <= -2.2) { deep = true; break; }
      }
      if (ok && deep) {
        return {
          island,
          dir: { x: dx * PLAYER.MOVE_SPEED, z: dz * PLAYER.MOVE_SPEED },
          start: { x: samples[startI].x, z: samples[startI].z },
        };
      }
    }
  }
  return null;
}

function findSaddle(pool) {
  for (const island of pool) {
    if (island.profile.terrainStyle !== 'archipelago') continue;
    const maxR = getIslandMaxRadius(island);
    const stepSize = maxR / 16;
    let saddle = null;
    let land = null;
    for (let gx = -maxR; gx <= maxR; gx += stepSize) {
      for (let gz = -maxR; gz <= maxR; gz += stepSize) {
        const x = island.position.x + gx;
        const z = island.position.z + gz;
        const { distRatio } = getIslandDistRatio(island, x, z);
        if (distRatio <= 0.8 && isSubmergedAt(island, x, z, T, 1.15)) {
          const depth = gerstnerHeight(x, z, T, WAVE_PARAMS) - getIslandSurfaceY(island, x, z);
          if (!saddle || depth > saddle.depth) saddle = { x, z, depth };
        }
        if (distRatio < 0.55) {
          const y = getIslandSurfaceY(island, x, z);
          if (y > 1.5 && (!land || y > land.y)) land = { x, z, y };
        }
      }
    }
    if (saddle && land) return { island, saddle, land };
  }
  return null;
}

function findCave(pool) {
  // Prefer the TIGHTEST dry cave (lowest headroom) so the ceiling-clamp assertion
  // is meaningfully exercised: grand mountain caverns are now tall enough that a
  // jump clears them, so the first-found cave no longer overshoots its roof.
  let best = null;
  for (const island of pool) {
    for (const cave of island.caves) {
      if ((cave.floorY ?? -99) <= 1.0) continue; // want a dry (above-water) cave
      const midX = cave.position.x - Math.sin(cave.rotation) * cave.length * 0.6;
      const midZ = cave.position.z - Math.cos(cave.rotation) * cave.length * 0.6;
      const ceil = getCaveCeilingY(island, midX, midZ);
      if (ceil === null) continue;
      if (!isPointInsideIslandFootprint(island, midX, midZ, 0)) continue;
      const headroom = ceil - getCaveFloorY(island, midX, midZ);
      if (best === null || headroom < best.headroom) {
        best = { island, cave, mid: { x: midX, z: midZ }, headroom };
      }
    }
  }
  return best;
}

function findIsolatedPalm(pool) {
  for (const island of pool) {
    const props = island.props ?? [];
    for (const palm of props) {
      if (!palm.type.startsWith('palm')) continue;
      const { distRatio } = getIslandDistRatio(island, palm.x, palm.z);
      if (distRatio > 0.7) continue; // keep it inland (clear of the water line)
      if (getIslandSurfaceY(island, palm.x, palm.z) < 1.0) continue;
      const blockR = PROP_COLLIDERS[palm.type].radius * palm.scale + PLAYER.RADIUS;
      let clear = true;
      for (const other of props) {
        if (other === palm) continue;
        const oc = PROP_COLLIDERS[other.type];
        if (!oc || oc.shape === 'none') continue;
        if (Math.hypot(other.x - palm.x, other.z - palm.z) < blockR + 3.5) { clear = false; break; }
      }
      if (clear) return { island, palm };
    }
  }
  return null;
}

function findSteepAscent(pool) {
  let best = null;
  for (const island of pool) {
    const maxR = getIslandMaxRadius(island);
    const stepSize = maxR / 20;
    for (let gx = -maxR; gx <= maxR; gx += stepSize) {
      for (let gz = -maxR; gz <= maxR; gz += stepSize) {
        const x = island.position.x + gx;
        const z = island.position.z + gz;
        const { distRatio } = getIslandDistRatio(island, x, z);
        if (distRatio > 0.9 || distRatio < 0.2) continue;
        const y = getIslandSurfaceY(island, x, z);
        if (y < 1.0) continue;
        const e = 0.5;
        const gxg = (getIslandSurfaceY(island, x + e, z) - getIslandSurfaceY(island, x - e, z)) / (2 * e);
        const gzg = (getIslandSurfaceY(island, x, z + e) - getIslandSurfaceY(island, x, z - e)) / (2 * e);
        const gmag = Math.hypot(gxg, gzg);
        if (gmag < 1.0) continue;
        const ux = gxg / gmag;
        const uz = gzg / gmag;
        // Measure the ACTUAL rise/run over a per-tick-sized uphill step — and
        // then keep measuring, out to the distance the walk test actually
        // covers. A single 0.12 m probe is not a cliff: a walker standing at
        // the LIP of one reads 4.1 rise/run over 12 cm and then 0.45 over the
        // next seven metres, which is a legitimate stroll across a shoulder,
        // and grading it as "the player climbed a cliff face" is how this
        // assertion went red when wave 9.4's second cave mouth reshaped a
        // hillside and handed the search a steeper lip than the real cliff it
        // used to find. The face has to STAY a face: every probe along the
        // uphill ray, over the ~7 m the 90-tick walk can cover, must be steep.
        const s = 0.12;
        const yUp = getIslandSurfaceY(island, x + ux * s, z + uz * s);
        if (yUp < 1.0) continue;
        const smallSlope = (yUp - y) / s;
        if (smallSlope <= 1.7) continue;
        let sustained = smallSlope;
        let broken = false;
        for (let d = 0.5; d <= 7.0; d += 0.5) {
          const yA = getIslandSurfaceY(island, x + ux * (d - 0.5), z + uz * (d - 0.5));
          const yB = getIslandSurfaceY(island, x + ux * d, z + uz * d);
          const seg = (yB - yA) / 0.5;
          if (yB < 1.0 || seg <= 1.7) { broken = true; break; }
          sustained = Math.min(sustained, seg);
        }
        if (broken) continue;
        if (!best || sustained > best.slope) {
          best = { island, at: { x, z }, up: { x: ux, z: uz }, slope: sustained };
        }
      }
    }
    if (best) return best; // first island that yields a steep spot is plenty
  }
  return best;
}

function findOpenSea(pool) {
  for (let x = -900; x <= 900; x += 60) {
    for (let z = -900; z <= 900; z += 60) {
      let clear = true;
      for (const island of pool) {
        const d = Math.hypot(x - island.position.x, z - island.position.z);
        if (d < getIslandMaxRadius(island) + 40) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  return null;
}

function findDryHighGround(pool) {
  for (const island of pool) {
    const { distRatio } = getIslandDistRatio(island, island.position.x, island.position.z);
    // Sample the interior for a solidly dry, roughly flat spot.
    const maxR = getIslandMaxRadius(island);
    const stepSize = maxR / 10;
    for (let gx = -maxR * 0.4; gx <= maxR * 0.4; gx += stepSize) {
      for (let gz = -maxR * 0.4; gz <= maxR * 0.4; gz += stepSize) {
        const x = island.position.x + gx;
        const z = island.position.z + gz;
        const y = getIslandSurfaceY(island, x, z);
        if (y < 3.0) continue;
        // Away from any cave trench.
        if (getCaveCeilingY(island, x, z) !== null) continue;
        return { island, at: { x, z } };
      }
    }
  }
  return null;
}

// ── 7. Surface swimming (liveplay-09) + riding the swell (vm:physics:4) ─────
// Drives the SHARED stepPirate (what Match.applyInput and the client predictor
// both run) and the real PhysicsSystem over a moving Gerstner sea.
{
  console.log('\n7. Surface swimming: W is a level stroke, the swimmer rides the swell');
  const sea = findOpenSea(POOL);
  const env = { ship: null, islands: [], jumpBlocked: false };
  const floatLine = (p, t) => gerstnerHeight(p.position.x, p.position.z, t, WAVE_PARAMS, stormSeaState(null, p.position.x, p.position.z)) + 0.32;
  function swim(input, seconds, settle = 2) {
    const p = makePlayer({ x: sea.x, y: 0, z: sea.z }, { state: 'swimming' });
    let t = 3;
    p.position.y = floatLine(p, t);
    let worst = 0, deepest = 0, minY = Infinity, maxY = -Infinity, minS = Infinity, maxS = -Infinity;
    const x0 = p.position.x, z0 = p.position.z;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      stepPirate(p, input, DT, env);
      physics.update(DT, t, [], [p], [], [], []);
      t += DT;
      const s = floatLine(p, t);
      if (t - 3 >= settle) {
        worst = Math.max(worst, Math.abs(p.position.y - s));
        minY = Math.min(minY, p.position.y); maxY = Math.max(maxY, p.position.y);
        minS = Math.min(minS, s); maxS = Math.max(maxS, s);
      }
      deepest = Math.max(deepest, s - p.position.y);
    }
    return { worst, deepest, travel: Math.hypot(p.position.x - x0, p.position.z - z0), yRange: maxY - minY, sRange: maxS - minS, state: p.state };
  }
  const physics = new PhysicsSystem();
  if (!sea) expect('open sea found for the swim cases', false);
  else {
    const base = { forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false, sailLower: false, crouch: false, yaw: 0.7, pitch: 0 };
    const level = swim({ ...base, forward: true, pitch: -0.2 }, 20);
    expect('W at pitch -0.2 keeps the head within 0.3 m of the float line for 18 s',
      level.worst <= 0.3 && level.state === 'swimming', `worst=${level.worst.toFixed(3)}m deepest=${level.deepest.toFixed(3)}m`);
    expect('W at pitch -0.2 still makes way (> 40 m in 20 s)', level.travel > 40, `travel=${level.travel.toFixed(1)}m`);
    const tread = swim({ ...base }, 24, 4);
    expect('treading water rides the swell (within 0.3 m of the moving surface)',
      tread.worst <= 0.3, `worst=${tread.worst.toFixed(3)}m swell range=${tread.sRange.toFixed(2)}m`);
    expect('the treading swimmer rises and falls >= 80% of the swell height',
      tread.sRange > 0.2 && tread.yRange >= 0.8 * tread.sRange, `yRange=${tread.yRange.toFixed(2)}m swell=${tread.sRange.toFixed(2)}m`);
    const steep = swim({ ...base, forward: true, pitch: -0.8 }, 4, 99);
    expect('a steep look down (< -35 deg) with W still dives (> 1.5 m in 4 s)', steep.deepest > 1.5, `deepest=${steep.deepest.toFixed(2)}m`);
    const crouchDive = swim({ ...base, forward: true, crouch: true, pitch: -0.5 }, 4, 99);
    expect('holding C with W follows the look down (> 1.0 m in 4 s at -0.5)', crouchDive.deepest > 1.0, `deepest=${crouchDive.deepest.toFixed(2)}m`);
    const shallowNoCrouch = swim({ ...base, forward: true, pitch: -0.5 }, 4, 99);
    expect('the same -0.5 look WITHOUT C stays at the surface (< 0.3 m)', shallowNoCrouch.deepest < 0.3, `deepest=${shallowNoCrouch.deepest.toFixed(2)}m`);
    const diveKey = swim({ ...base, sailLower: true }, 4, 99);
    expect('the dive key still takes the swimmer under (> 1.0 m in 4 s)', diveKey.deepest > 1.0, `deepest=${diveKey.deepest.toFixed(2)}m`);
  }
}

// ── 8. The body has mass (physics-12, b2.1h) ────────────────────────────────
// Shared stepPirate (server + client predictor) and, for the hull leap, the
// real PhysicsSystem. Ground accel 40 / decel 55 / air 8 m/s^2, air momentum
// kept, and a body that leaves a hull keeps the hull's way (v + omega x r).
{
  console.log('\n8. On-foot mass: ground accel/decel, air momentum, leaving a moving hull');
  const base = { forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false, sailLower: false, crouch: false, yaw: 0, pitch: 0 };
  const dry = findDryHighGround(POOL);
  if (!dry) expect('dry high ground found for the ground-accel cases', false);
  else {
    const env = { ship: null, islands: [dry.island], jumpBlocked: false };
    const p = makePlayer({ x: dry.at.x, y: getIslandSurfaceY(dry.island, dry.at.x, dry.at.z), z: dry.at.z });
    let tReach = null;
    for (let i = 1; i <= 60 && tReach === null; i++) {
      stepPirate(p, { ...base, forward: true }, DT, env);
      p.position.y = getIslandSurfaceY(dry.island, p.position.x, p.position.z);
      p.velocity.y = 0;
      if (Math.hypot(p.velocity.x, p.velocity.z) >= 4.5 - 1e-9) tReach = i * DT;
    }
    expect('ground: 0 -> 4.5 m/s takes 0.10-0.16 s', tReach !== null && tReach >= 0.10 && tReach <= 0.16, `t=${tReach === null ? 'never' : tReach.toFixed(3)}s`);
    for (let i = 0; i < 30; i++) {
      stepPirate(p, { ...base, forward: true }, DT, env);
      p.position.y = getIslandSurfaceY(dry.island, p.position.x, p.position.z);
      p.velocity.y = 0;
    }
    let tStop = null;
    for (let i = 1; i <= 60 && tStop === null; i++) {
      stepPirate(p, { ...base }, DT, env);
      p.position.y = getIslandSurfaceY(dry.island, p.position.x, p.position.z);
      p.velocity.y = 0;
      if (p.velocity.x === 0 && p.velocity.z === 0) tStop = i * DT;
    }
    expect('ground: a walker on release stops in 0.06-0.14 s (decel 55)', tStop !== null && tStop >= 0.06 && tStop <= 0.14, `t=${tStop === null ? 'never' : tStop.toFixed(3)}s`);
  }
  {
    const air = { ship: null, islands: [], jumpBlocked: false };
    const p = makePlayer({ x: 0, y: 50, z: 0 });
    p.velocity = { x: 0, y: 2, z: 4.5 };
    for (let i = 0; i < Math.round(0.3 / DT); i++) stepPirate(p, { ...base, back: true }, DT, air);
    const dv = Math.hypot(p.velocity.x, p.velocity.z - 4.5);
    expect('air: holding S for 0.3 s mid-leap changes velocity by <= 2.5 m/s (and does change it)', dv <= 2.5 && dv > 1.5, `dv=${dv.toFixed(2)} m/s vz=${p.velocity.z.toFixed(2)}`);
    const q = makePlayer({ x: 0, y: 50, z: 0 });
    q.velocity = { x: 3, y: 2, z: 4 };
    for (let i = 0; i < 20; i++) stepPirate(q, { ...base }, DT, air);
    expect('air: no input keeps horizontal momentum', q.velocity.x === 3 && q.velocity.z === 4 && Math.abs(q.position.x - 3 * 20 * DT) < 1e-9, `v=(${q.velocity.x}, ${q.velocity.z}) x=${q.position.x.toFixed(3)}`);
  }
  const sea = findOpenSea(POOL);
  if (!sea) expect('open sea found for the hull leap', false);
  else {
    const stats = SHIP_STATS.sloop;
    const ship = {
      id: 'leap-sloop', type: 'sloop', ownerId: 'o', crewIds: [], position: { x: sea.x, y: 0, z: sea.z }, rotation: 0,
      velocity: { x: 0, y: 0, z: 12 }, angularVelocity: 0, sailHeight: 0, sailAngle: 0, anchored: false,
      anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
      fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
      chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
      repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [], rudderAngle: 0,
    };
    const physics = new PhysicsSystem();
    const p = makePlayer({ x: sea.x, y: 0, z: sea.z + 3 }, { onShipId: ship.id, mastClimb: null });
    // On the weather deck (the hold floor is what getShipFloorYAt reports at y 0).
    p.position.y = ship.position.y + stats.height + 0.14;
    let t = 3;
    const pin = () => { ship.velocity.x = 0; ship.velocity.z = 12; ship.angularVelocity = 0; };
    const tick = (input) => {
      pin();
      stepPirate(p, input, DT, { ship: p.onShipId === ship.id ? ship : null, islands: [], jumpBlocked: false });
      physics.update(DT, t, [ship], [p], [], [], []);
      t += DT;
    };
    // Start 3 m forward of midships (clear of the hatch), walk to the rail
    // (right = -x at yaw 0), then leap over it.
    for (let i = 0; i < 90; i++) tick({ ...base, right: true });
    const aboardAtRail = p.onShipId === ship.id;
    p.shipBoundaryGraceTimer = 1.5;
    const takeoffZ = p.position.z;
    tick({ ...base, right: true, jumpPressed: true });
    let leftAt = null, splashZ = null;
    for (let i = 0; i < 300 && splashZ === null; i++) {
      tick({ ...base, right: true });
      if (leftAt === null && p.onShipId === null) leftAt = { vz: p.velocity.z };
      if (p.state === 'swimming') splashZ = p.position.z;
    }
    expect('hull leap: the pirate reached the rail and was still aboard', aboardAtRail, `state=${p.state} onShip=${p.onShipId} x-off=${(p.position.x - ship.position.x).toFixed(2)} y=${p.position.y.toFixed(2)}`);
    expect('hull leap: leaving a 12 m/s hull carries its way (vz >= 11 m/s once off)', leftAt !== null && leftAt.vz >= 11, `vz=${leftAt ? leftAt.vz.toFixed(2) : 'never left'}`);
    const downstream = splashZ === null ? null : splashZ - takeoffZ;
    expect('hull leap: a jump off a 12 m/s hull lands >= 7 m downstream', downstream !== null && downstream >= 7, `downstream=${downstream === null ? 'no splash' : downstream.toFixed(2)} m`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} locomotion assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll locomotion assertions passed.');
