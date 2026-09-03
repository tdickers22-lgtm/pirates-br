// SHIP HELM / ANCHOR / CANVAS — pure three.js under node, no browser.
//
// Three cheap correctness defects on the objects a captain looks at most.
//
// ships-12 — the helm wheel integrated yaw RATE (`rotation.z -= angularVelocity
// * 0.22`). Hauling it hard over at anchor moved nothing, and a ram that span
// the hull span the wheel with nobody on it. Ship.rudderAngle has been on the
// wire the whole time and the rudder blade under the counter never turned at
// all.
//
// ships-11 — the anchor descended a fixed 2.75 m from H + 0.34, so on the
// galleon it hung in the air above the sea while the capstan spun.
//
// ships-15 — deployed sail `> 0.05` and furled bundle `<= 0.12` drew BOTH
// canvases for ~7% of the hoist range, and the "torn planking" decal on the
// inboard bulwark sat at H + 0.17 for holes that PhysicsSystem clamps to 0.6H,
// i.e. always on planking that is not holed.
//
// RED ON HEAD: wheel still at rudder lock and spinning on angular velocity;
// galleon anchor at +1.09 m; sailHeight 0.10 draws sail AND bundle.
//
//   node --import tsx scripts/test-ship-helm-anchor.mjs
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP, SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function fixtureShip(type) {
  return {
    id: `helm-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, rudderAngle: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

const scene = new THREE.Scene();
const sr = new ShipRenderer();
sr.init(scene, 'high');
openFirstDrawBudgetForSettle();
const cam = new THREE.Vector3(12, 6, 12);
const settle = (ship, t0 = 0) => { for (let i = 0; i < 40; i++) sr.update([ship], [], t0 + i * 0.001, 0.5, 0, cam); };

// ── THE WHEEL READS THE RUDDER ──────────────────────────────────────────────
{
  const ship = fixtureShip('brigantine');
  ship.anchored = true;          // dead in the water: nothing is yawing
  settle(ship, 5);
  const mesh = sr.shipMeshes.get(ship.id);
  const rest = mesh.wheel.rotation.z;
  const bladeAngle = () => mesh.rudderPivot?.rotation?.y ?? NaN;
  const restRudder = bladeAngle();
  ship.rudderAngle = SHIP.RUDDER_MAX_ANGLE;      // hard over, still at anchor
  settle(ship, 6);
  const hardOver = mesh.wheel.rotation.z;
  const bladeOver = bladeAngle();
  console.log(`  at anchor, rudder 0 -> ${SHIP.RUDDER_MAX_ANGLE}: wheel ${rest.toFixed(3)} -> ${hardOver.toFixed(3)} rad, blade ${restRudder.toFixed(3)} -> ${bladeOver.toFixed(3)} rad`);
  expect('a helmsman at anchor turning hard over sees the wheel move',
    Math.abs(hardOver - rest) > 1, `wheel moved ${Math.abs(hardOver - rest).toFixed(4)} rad`);
  expect('three quarter-turns lock to lock (2.356 rad at full lock)',
    Math.abs(Math.abs(hardOver) - 0.75 * Math.PI) < 0.02, `|wheel| = ${Math.abs(hardOver).toFixed(4)}`);
  expect('the rudder blade under the counter follows the wire angle',
    Math.abs(bladeOver - SHIP.RUDDER_MAX_ANGLE) < 0.02, `blade ${bladeOver.toFixed(4)} rad`);
  // Half lock is half the wheel: the mapping is linear, not a bang-bang.
  ship.rudderAngle = SHIP.RUDDER_MAX_ANGLE * 0.5;
  settle(ship, 7);
  expect('half lock is half a wheel',
    Math.abs(Math.abs(mesh.wheel.rotation.z) - 0.375 * Math.PI) < 0.02,
    `|wheel| = ${Math.abs(mesh.wheel.rotation.z).toFixed(4)}`);
  // A ram spins the hull. The wheel is not connected to that.
  ship.rudderAngle = 0;
  settle(ship, 8);
  const centred = mesh.wheel.rotation.z;
  ship.angularVelocity = 1.4;
  settle(ship, 9);
  console.log(`  rammed (angularVelocity 1.4, rudder centred): wheel ${centred.toFixed(4)} -> ${mesh.wheel.rotation.z.toFixed(4)} rad`);
  expect('a ram that spins the hull does not spin the wheel',
    Math.abs(mesh.wheel.rotation.z - centred) < 0.01);
}

// ── A DROPPED ANCHOR IS IN THE WATER ────────────────────────────────────────
for (const type of ['sloop', 'brigantine', 'galleon']) {
  const ship = fixtureShip(type);
  ship.anchored = true;
  ship.anchorRaiseProgress = 0;   // fully dropped
  settle(ship, 10);
  const mesh = sr.shipMeshes.get(ship.id);
  const draft = mesh.hullProfile.draft;
  const stockY = mesh.anchor.position.y;
  // The hull origin sits at the calm waterline, so the local y IS the depth.
  console.log(`  ${type}: H ${SHIP_STATS[type].height}, draft ${draft.toFixed(2)} -> anchor stock y ${stockY.toFixed(2)} m`);
  expect(`${type}: the anchor stock is below the keel line at full drop (y ${stockY.toFixed(2)} < -${draft.toFixed(2)})`,
    stockY < -draft, 'the anchor hangs in the air with the capstan spinning');
  expect(`${type}: the chain pays out far enough to reach it`,
    mesh.anchorChain.scale.y > 0.52 + 0.76 * ((SHIP_STATS[type].height + 0.34 + draft + 0.6) / 2.75) - 0.05);
}

// ── ONE CANVAS AT A TIME, AND NO FAKE DECAL ON THE BULWARK ──────────────────
{
  const ship = fixtureShip('brigantine');
  const overlaps = [];
  for (let h = 0; h <= 1.0001; h += 0.01) {
    ship.sailHeight = Math.round(h * 1000) / 1000;
    settle(ship, 12 + h);
    const mesh = sr.shipMeshes.get(ship.id);
    const set = mesh.sails.some((s) => s.visible);
    const rolled = mesh.furledSails.some((s) => s.visible);
    if (set && rolled) overlaps.push(ship.sailHeight);
    if (!set && !rolled) overlaps.push(`bare@${ship.sailHeight}`);
  }
  console.log(`  hoist sweep 0..1 step 0.01: ${overlaps.length} heights draw both canvases or neither${overlaps.length ? ` (${overlaps.slice(0, 6).join(', ')}...)` : ''}`);
  expect('exactly one of set canvas / furled bundle is drawn at every hoist',
    overlaps.length === 0, `${overlaps.length} bad heights`);

  // A hole never spawns the inboard bulwark decal any more.
  const stats = SHIP_STATS.brigantine;
  ship.sailHeight = 1;
  ship.holes = [{ id: 1, x: 0, y: stats.height * 0.58, z: 0, patched: false }];
  settle(ship, 14);
  const mesh = sr.shipMeshes.get(ship.id);
  const vis = mesh.holeVis.get(1);
  expect('a topside breach (0.58H, above the old 0.5H trigger) is still drawn', !!vis);
  expect('no fake torn-planking decal is painted on the un-holed inboard bulwark',
    vis && !('inner' in vis && vis.inner));
  let aboveDeck = 0;
  vis?.group.traverse((o) => { if (o.isMesh && o.getWorldPosition(new THREE.Vector3()).y > stats.height + 0.1) aboveDeck += 1; });
  expect('nothing belonging to the breach sits above the deck plane', aboveDeck === 0);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
