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
  // The whole ship root: the LOD1 sibling and the hole-vis groups hang there.
  return drawn(sr.shipMeshes.get(ship.id).root);
}

// b4.2d (D26 ship LOD): the detail model now ends at 30 m (+10% hysteresis);
// 30-90 m is LOD1 (spline shell + baked parts, no hold, no see-through cut)
// and on the low tier every hull but your own starts at LOD2. So at 80 m a
// hull that is not yours draws NO hold in any state (a stronger cull than the
// 60 m sealed-hold rule, which now only matters for your own hull from a
// free camera), its breaches show through their hole-vis groups on the ship
// root, and your own hull is the detail model with its whole hold.
for (const quality of ['high', 'balanced']) {
  for (const type of ['sloop', 'brigantine', 'galleon']) {
    const scene = new THREE.Scene();
    const sr = new ShipRenderer();
    sr.init(scene, quality);
    openFirstDrawBudgetForSettle();
    const ship = fixtureShip(type, `holdcull-${quality}-${type}`);
    const near = new THREE.Vector3(18, 6, 18);
    const far = new THREE.Vector3(0, 12, 80); // past the 60 m hold cull, in the D26 LOD1 band (30-90 m)

    const nearSet = frame(sr, ship, near);
    const farSet = frame(sr, ship, far);
    const mesh = sr.shipMeshes.get(ship.id);
    expect(`${quality} ${type}: the far hull at 80 m is LOD1 (the detail model and its hold are not drawn)`,
      !mesh.detailRoot.visible && mesh.lod1Root.visible && !mesh.proxyRoot.visible);
    const saved = verts(nearSet) - verts(farSet);
    const hidden = [...nearSet].filter((m) => !farSet.has(m));
    const minSave = type === 'galleon' ? 10000 : type === 'brigantine' ? 7000 : 4000;
    console.log(`  ${quality} ${type}: near ${verts(nearSet)} verts, sealed at 80 m ${verts(farSet)} (-${saved}, ${hidden.length} meshes)`);
    expect(`${quality} ${type}: a sealed hull at 80 m skips its hold (>= ${minSave} verts)`, saved >= minSave, `saved ${saved}`);

    const holdSet = new Set(mesh.holdInterior ?? []);
    const holdMeshes = new Set();
    for (const o of holdSet) o.traverse((c) => { if (c.isMesh) holdMeshes.add(c); });
    const holdDrawn = (set) => [...holdMeshes].filter((m) => set.has(m));
    expect(`${quality} ${type}: no hold mesh is drawn at 80 m`, holdMeshes.size > 0 && holdDrawn(farSet).length === 0,
      `${holdDrawn(farSet).length} of ${holdMeshes.size}`);
    expect(`${quality} ${type}: the LOD1 shell has no breach discard (no see-through cut with no hold behind it)`,
      (() => {
        const shell = [...farSet].find((m) => m.material?.name === 'lod1-hull-shell');
        return !!shell && shell.material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile
          && [...farSet].every((m) => !mesh.detailRoot.getObjectById(m.id));
      })());
    let lights = 0;
    for (const o of holdSet) o.traverse((c) => { if (c.isLight) lights += 1; });
    expect(`${quality} ${type}: the cull never toggles a light (a light-count change relinks every material)`, lights === 0);

    // Open breach at range: LOD1 draws no hold; the breach reads through its
    // hole-vis group, which hangs on the ship root and so survives the swap.
    ship.holes = [{ id: 1, x: SHIP_STATS[type].width * 0.5, y: 0.3, z: 0, patched: false }];
    ship.nextHoleId = 2;
    const breachSet = frame(sr, ship, far);
    const vis = mesh.holeVis.get(1);
    let visDrawn = 0;
    if (vis) vis.group.traverse((o) => { if (o.isMesh && breachSet.has(o)) visDrawn += 1; });
    expect(`${quality} ${type}: an open breach at 80 m draws its hole-vis on LOD1, not the hold`,
      visDrawn > 0 && holdDrawn(breachSet).length === 0, `hole-vis meshes drawn ${visDrawn}, hold meshes ${holdDrawn(breachSet).length}`);
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
    expect(`${quality} ${type}: a foundering hull at 80 m stays LOD1 (no hold)`, holdDrawn(sinkSet).length === 0 && mesh.lod1Root.visible);
    ship.sinking = false;
    const backSet = frame(sr, ship, near);
    expect(`${quality} ${type}: back inside 60 m the hold is drawn again`, hidden.every((m) => backSet.has(m)));
    sr.dispose?.();
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) { console.error(`test-ship-hold-cull: ${failures} FAIL`); process.exit(1); }
console.log('test-ship-hold-cull: OK');
