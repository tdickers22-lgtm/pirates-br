// test-flood-trim.mjs: b2.2c (holes-02, liveplay-02, PLAN 3.6 "Water mass").
//
// The REAL PhysicsSystem at the 0.016 s server tick, a sloop in open water with
// no islands. Everything is read from the public ship state the client gets
// (roll, pitch, position.y, waterLevel), so the suite grades the water MASS as
// the player sees it, not a helper's return value.
//
//   1  flood to 0.8 through two breaches on the STARBOARD rail (-x; +x is the
//      helmsman's left = port, PLAN 3.7): |roll| >= 4 deg with the starboard
//      rail low.
//   2  plank every hole, bail at one bailer's rate: the list (roll averaged
//      over one 5.5 s sea period) stays >= 3 deg to starboard until the water
//      is below 0.2 (the old list came
//      only from open breaches and snapped level the tick the last one was
//      patched).
//   3  mean draft grows >= 0.5 m from fill 0 to fill 0.8 (sloop).
//   4  the same beam sea at fill 0.5 (no holes): roll amplitude (RMS about her
//      mean) >= 1.2x the dry hull's.
//   5  the slosh settles: a 0.1 rad roll blow at fill 0.5 is gone within 6 s
//      (graded against an untouched twin in the same sea, so wave motion does
//      not count as "not settled").
//
// Logic tier (pure node, ~3 s: two 75 s beam-sea runs plus a 20 s heading search).
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP_STATS, FLOODING } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL ${label}${detail ? `\n       ${detail}` : ''}`); failures += 1; }
}
const DEG = Math.PI / 180;
const TICK = 0.016;
const deg = (r) => (r / DEG).toFixed(2);

function makeShip(type, extra = {}) {
  const stats = SHIP_STATS[type];
  return {
    id: `ft-${type}`, type, ownerId: 'owner', crewIds: [], position: { x: 310, y: 0, z: -220 }, rotation: 0.4,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 0, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: stats.maxHull, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [], waterLevel: 0,
    ...extra,
  };
}

/** Step one or more hulls together; `each(i, t)` runs after every tick. */
function run(physics, ships, t0, seconds, each) {
  const n = Math.round(seconds / TICK);
  let t = t0;
  for (let i = 0; i < n; i += 1) {
    t = t0 + (i + 1) * TICK;
    physics.update(TICK, t, ships, [], [], [], [], null);
    if (each && each(i, t) === false) break;
  }
  return t;
}

// ── 1 + 2: flood to 0.8 on the starboard rail, then plank and bail ─────────
console.log('\nSection 1-2: she lists to the WATER, and the list outlives the holes');
{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop');
  const halfW = SHIP_STATS.sloop.width * 0.5;
  // Two breaches low on the starboard (-x) rail, well under the calm line.
  ship.holes = [-1.2, 1.2].map((z, i) => ({ id: i + 1, x: -halfW * 0.92, y: -0.2, z, patched: false, size: 1, source: 'cannon', tier: 0 }));
  ship.nextHoleId = 3;
  let t = run(physics, [ship], 0, 3); // settle onto the sea first
  let flooded = false;
  t = run(physics, [ship], t, 400, () => {
    if ((ship.waterLevel ?? 0) >= 0.8) { flooded = true; return false; }
    return true;
  });
  expect('the fixture floods to 0.8 through two starboard breaches', flooded, `water=${(ship.waterLevel ?? 0).toFixed(3)} at t=${t.toFixed(1)} s`);
  // Hold the water at 0.8 for 2 s and read her mean attitude.
  let sumRoll = 0; let n = 0;
  t = run(physics, [ship], t, 2, () => { ship.waterLevel = 0.8; sumRoll += ship.roll ?? 0; n += 1; });
  const rollAt08 = sumRoll / Math.max(1, n);
  // +roll lifts +x (port), so the starboard rail low = positive roll.
  expect('fill 0.8 with the water to starboard: |roll| >= 4 deg, starboard rail low',
    rollAt08 >= 4 * DEG, `mean roll ${deg(rollAt08)} deg (+ = starboard low)`);

  for (const h of ship.holes) h.patched = true;
  // The LIST is her mean attitude: graded as the roll averaged over the last
  // 5.5 s (one period of the weather-0 beam sea, test 4), so the wave rolling
  // on top of it is not mistaken for the list going away.
  const WINDOW = Math.round(5.5 / TICK);
  const ring = [];
  let minList = Infinity; let minAt = 0; let ticks = 0; let minRaw = Infinity;
  const bail = FLOODING.BAIL_RATE;
  run(physics, [ship], t, 200, () => {
    ship.waterLevel = Math.max(0, (ship.waterLevel ?? 0) - bail * TICK);
    if ((ship.waterLevel ?? 0) < 0.2) return false;
    ring.push(ship.roll ?? 0);
    if (ring.length > WINDOW) ring.shift();
    minRaw = Math.min(minRaw, ship.roll ?? 0);
    if (ring.length === WINDOW) {
      ticks += 1;
      const list = ring.reduce((a, b) => a + b, 0) / WINDOW;
      if (list < minList) { minList = list; minAt = ship.waterLevel ?? 0; }
    }
    return true;
  });
  expect('every hole planked and one bailer working: the list stays >= 3 deg to starboard until the water is under 0.2',
    ticks > 100 && minList >= 3 * DEG, `min 5.5 s mean roll ${deg(minList)} deg at water ${minAt.toFixed(3)} over ${ticks} ticks (min single tick ${deg(minRaw)} deg)`);
}

// ── 3: draft grows with the water ──────────────────────────────────────────
console.log('\nSection 3: the water pushes her down');
{
  const meanY = (fill) => {
    const physics = new PhysicsSystem();
    const ship = makeShip('sloop', { waterLevel: fill });
    let t = run(physics, [ship], 0, 12, () => { ship.waterLevel = fill; });
    let sum = 0; let n = 0;
    run(physics, [ship], t, 10, () => { ship.waterLevel = fill; sum += ship.position.y; n += 1; });
    return sum / n;
  };
  const y0 = meanY(0); const y8 = meanY(0.8);
  expect('sloop mean draft grows >= 0.5 m from fill 0 to 0.8', y0 - y8 >= 0.5,
    `y(0)=${y0.toFixed(3)} y(0.8)=${y8.toFixed(3)} draft +${(y0 - y8).toFixed(3)} m`);
}

// ── 4: free surface: a half-full hull rolls more in the same sea ────────────
console.log('\nSection 4: free-surface effect in a beam sea');
function rollStats(fill, rotation, seconds = 60) {
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', { waterLevel: fill, rotation });
  let t = run(physics, [ship], 0, 15, () => { ship.waterLevel = fill; });
  const rolls = [];
  run(physics, [ship], t, seconds, () => { ship.waterLevel = fill; rolls.push(ship.roll ?? 0); });
  const mean = rolls.reduce((a, b) => a + b, 0) / rolls.length;
  const rms = Math.sqrt(rolls.reduce((a, b) => a + (b - mean) ** 2, 0) / rolls.length);
  let crossings = 0;
  for (let i = 1; i < rolls.length; i += 1) if ((rolls[i - 1] - mean) < 0 && (rolls[i] - mean) >= 0) crossings += 1;
  return { mean, rms, period: crossings > 0 ? (rolls.length * TICK) / crossings : Infinity };
}
{
  // The beam sea is the heading the dry hull rolls most in.
  let beam = 0; let best = -1;
  for (let k = 0; k < 4; k += 1) {
    const rot = (k / 4) * Math.PI;
    const s = rollStats(0, rot, 20);
    if (s.rms > best) { best = s.rms; beam = rot; }
  }
  const dry = rollStats(0, beam);
  const half = rollStats(0.5, beam);
  console.log(`  beam heading ${beam.toFixed(2)} rad: dry rms ${deg(dry.rms)} deg period ${dry.period.toFixed(2)} s; fill 0.5 rms ${deg(half.rms)} deg period ${half.period.toFixed(2)} s mean ${deg(half.mean)} deg`);
  expect('fill 0.5 rolls >= 1.2x the dry hull in the same beam sea', half.rms >= 1.2 * dry.rms,
    `ratio ${(half.rms / Math.max(1e-9, dry.rms)).toFixed(2)}`);
  expect('the half-full hull is still finite and inside the list ceiling', Number.isFinite(half.mean) && Math.abs(half.mean) <= 0.3,
    `mean ${deg(half.mean)} deg`);
}

// ── 5: the slosh rings down ────────────────────────────────────────────────
console.log('\nSection 5: a blow at fill 0.5 settles within 6 s');
{
  // Twins in separate worlds at the same spot (sharing one world would let the
  // hull-hull contact shove them apart into different seas).
  const pa = new PhysicsSystem();
  const pb = new PhysicsSystem();
  const a = makeShip('sloop', { waterLevel: 0.5 });
  const b = makeShip('sloop', { waterLevel: 0.5 });
  const both = (seconds, t0, each) => {
    const n = Math.round(seconds / TICK);
    let t = t0;
    for (let i = 0; i < n; i += 1) {
      t = t0 + (i + 1) * TICK;
      a.waterLevel = 0.5; b.waterLevel = 0.5;
      pa.update(TICK, t, [a], [], [], [], [], null);
      pb.update(TICK, t, [b], [], [], [], [], null);
      if (each) each(i);
    }
    return t;
  };
  const t = both(25, 0);
  const pre = Math.abs((a.roll ?? 0) - (b.roll ?? 0));
  const omega = (2 * Math.PI) / 3.5; // sloop roll period (test-seakeeping pins 3-4 s)
  pa.applyHullImpulse(a, { rollRate: 0.1 * omega });
  let peak = 0; let late = 0;
  both(10, t, (i) => {
    const d = Math.abs((a.roll ?? 0) - (b.roll ?? 0));
    peak = Math.max(peak, d);
    if ((i + 1) * TICK >= 6) late = Math.max(late, d);
  });
  expect('the blow reached ~0.1 rad', peak >= 0.06, `peak ${peak.toFixed(3)} rad (twins differed by ${pre.toFixed(4)} before)`);
  expect('6-10 s after the blow she is back within 0.01 rad of her untouched twin', late <= 0.01,
    `max |diff| ${late.toFixed(4)} rad after 6 s`);
}

console.log(failures === 0 ? '\nAll flood-trim assertions passed' : `\n${failures} flood-trim assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
