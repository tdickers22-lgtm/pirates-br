// SHIP HOLD CULL — pure three.js under node, no browser (b2-device-04).
//
// WHY. The hold interior v2 (floor, bilge boards, inner wall, hammocks, cargo)
// grew every hull 8-14% (galleon 98k -> 112k verts) and it was drawn, and cast
// into the shadow pass, for every hull inside the detail range (170/285/380 m)
// although closed planking hides it: from outside a hold only shows down the
// companionway at close range or through an OPEN breach.
//
// CONTRACT. A sealed hull beyond 60 m draws none of its hold-only meshes; the
// same hull with an open breach, a sinking hull, the local player's own hull
// and any hull inside 60 m draw all of it. Only meshes whose material nothing
// outside the hold uses are culled (merge batches by material), so no deck,
// hull or rig mesh ever changes visibility and no draw call is split.
//
// RED ON HEAD: the far sealed galleon draws exactly as many verts as the near
// one (the interior has no distance rule at all).
//
//   node --import tsx scripts/test-ship-hold-cull.mjs
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function fixtureShip(type, id) {
  return {
    id, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

/** Meshes actually submitted: visible themselves and every ancestor up to root. */
function drawn(root) {
  const out = new Set();
  const walk = (o) => {
    if (!o.visible) return;
    if (o.isMesh) out.add(o);
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}
const verts = (set) => [...set].reduce((a, m) => a + (m.geometry.attributes.position?.count ?? 0), 0);

let tt = 30;
function frame(sr, ship, cam, local) {
  for (let i = 0; i < 3; i++) { tt += 0.02; sr.update([ship], [], tt, 1 / 60, 0, cam, local); }
  return drawn(sr.shipMeshes.get(ship.id).detailRoot);
}

for (const quality of ['high', 'low']) {
  for (const type of ['sloop', 'brigantine', 'galleon']) {
    const scene = new THREE.Scene();
    const sr = new ShipRenderer();
    sr.init(scene, quality);
    openFirstDrawBudgetForSettle();
    const ship = fixtureShip(type, `holdcull-${quality}-${type}`);
    const near = new THREE.Vector3(18, 6, 18);
    const far = new THREE.Vector3(0, 12, 140); // inside the low detail range (170 m) too

    const nearSet = frame(sr, ship, near);
    const farSet = frame(sr, ship, far);
    const mesh = sr.shipMeshes.get(ship.id);
    expect(`${quality} ${type}: the far hull is the DETAIL model (the cull is inside the detail band)`,
      mesh.detailRoot.visible && !mesh.proxyRoot.visible);
    const saved = verts(nearSet) - verts(farSet);
    const hidden = [...nearSet].filter((m) => !farSet.has(m));
    const minSave = type === 'galleon' ? 10000 : type === 'brigantine' ? 7000 : 4000;
    console.log(`  ${quality} ${type}: near ${verts(nearSet)} verts, sealed at 140 m ${verts(farSet)} (-${saved}, ${hidden.length} meshes)`);
    expect(`${quality} ${type}: a sealed hull at 140 m skips its hold (>= ${minSave} verts)`, saved >= minSave, `saved ${saved}`);

    const holdSet = new Set(mesh.holdInterior ?? []);
    const holdMeshes = new Set();
    for (const o of holdSet) o.traverse((c) => { if (c.isMesh) holdMeshes.add(c); });
    const stray = hidden.filter((m) => !holdMeshes.has(m));
    expect(`${quality} ${type}: nothing but hold-only meshes is culled`, stray.length === 0,
      stray.map((m) => `${m.name || '?'}:${m.material?.name || '?'}`).join(', '));
    const deckMats = new Set();
    for (const m of nearSet) if (!holdMeshes.has(m)) deckMats.add(m.material);
    const sharedCulled = hidden.filter((m) => deckMats.has(m.material));
    expect(`${quality} ${type}: no culled mesh shares a material with deck/hull (no split draw, no lost deck timber)`,
      sharedCulled.length === 0, sharedCulled.map((m) => m.material?.name).join(', '));
    let lights = 0;
    for (const o of holdSet) o.traverse((c) => { if (c.isLight) lights += 1; });
    expect(`${quality} ${type}: the cull never toggles a light (a light-count change relinks every material)`, lights === 0);

    // Open breach at range: the hold shows through it.
    ship.holes = [{ id: 1, x: SHIP_STATS[type].width * 0.5, y: 0.3, z: 0, patched: false }];
    ship.nextHoleId = 2;
    const breachSet = frame(sr, ship, far);
    expect(`${quality} ${type}: an open breach at 140 m draws the whole hold`, hidden.every((m) => breachSet.has(m)));
    ship.holes = [{ id: 1, x: SHIP_STATS[type].width * 0.5, y: 0.3, z: 0, patched: true }];
    const patchedSet = frame(sr, ship, far);
    expect(`${quality} ${type}: once patched, the sealed hull culls it again`, hidden.every((m) => !patchedSet.has(m)));

    // Own hull at range (free-cam / spectate of own ship): always drawn.
    ship.crewIds = ['me'];
    const ownSet = frame(sr, ship, far, 'me');
    expect(`${quality} ${type}: the local crew's own hull always draws its hold`, hidden.every((m) => ownSet.has(m)));
    ship.crewIds = [];
    ship.sinking = true;
    const sinkSet = frame(sr, ship, far);
    expect(`${quality} ${type}: a foundering hull draws its hold`, hidden.every((m) => sinkSet.has(m)));
    ship.sinking = false;
    const backSet = frame(sr, ship, near);
    expect(`${quality} ${type}: back inside 60 m the hold is drawn again`, hidden.every((m) => backSet.has(m)));
    sr.dispose?.();
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) { console.error(`test-ship-hold-cull: ${failures} FAIL`); process.exit(1); }
console.log('test-ship-hold-cull: OK');
