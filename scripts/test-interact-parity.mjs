#!/usr/bin/env node
// PROMPT ⊆ GRANT — the invariant that was enforced by habit until it wasn't.
//
// Every station prompt the client offers is checked by the server with a SHARED
// reach predicate (isNearHelm, isNearSailStation, findBraceStationDir,
// isNearAnchor, isNearCrowNestLadder, findNearbyCannonIndex, isNearAmmoCrate).
// Nine stations pre-gate their candidate on that predicate; brace did not, and
// its 4.0 m / dot 0.1 cone beat the wheel and the guns from half the deck —
// "[X] Hold — Brace the Yard" 0.5 m from a cannon, X refused, the player never
// mans the gun (hud-12 / liveplay-02).
//
// So: walk a 0.25 m grid of the weather deck of all three hulls, look along 8
// yaws from each square, ask the CLIENT arbiter what [X] offers, and ask the
// SHARED predicate the server calls whether that press would be granted. Every
// offered station intent must be granted. No stack, no browser.
import * as THREE from 'three';
import { InteractionPrompts } from '../src/client/systems/InteractionPrompts.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  findBraceStationDir,
  findNearbyCannonIndex,
  getShipFloorYAt,
  isNearAmmoCrate,
  isNearAnchor,
  isNearCrowNestLadder,
  isNearHelm,
  isNearSailStation,
  isStandingOnShipDeck,
  toShipWorldPoint,
} from '../src/shared/interactions.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

/** The server's grant for each station intent, from the SAME shared predicate
 *  Match.tryInteractIntent calls (Match.ts:4688 switch). Only the reach half —
 *  occupancy/sinking/materials are separate refusals and not what parity is
 *  about. A prompt whose reach fails is a prompt that lies. */
const GRANTS = {
  helm: (p, s) => isNearHelm(p, s),
  sails: (p, s) => isNearSailStation(p, s),
  brace: (p, s) => findBraceStationDir(p, s) !== 0,
  anchor: (p, s) => isNearAnchor(p, s),
  crow: (p, s) => isNearCrowNestLadder(p, s),
  cannon: (p, s) => findNearbyCannonIndex(p, s) !== null,
  ammo: (p, s) => isNearAmmoCrate(p, s),
};

function makeRig(shipType) {
  const ship = {
    id: 'ship-1', type: shipType, alive: true, sinking: false,
    position: { x: 40, y: 1.4, z: -12 }, rotation: 0.6,
    sailHeight: 0.4, sailAngle: 0, sailIntegrity: 1, anchored: true, anchorRaiseProgress: 0,
    waterLevel: 0, holes: [], upgrades: [], inventory: [], crewIds: [], cannonCooldowns: [],
  };
  const player = {
    id: 'p1', shipId: ship.id, onShipId: ship.id, state: 'alive',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 },
    atHelm: false, atCannon: false, atCrowNest: false, mastClimb: null,
    weapons: [], activeSlot: 0, equippedTool: null, pocketWood: 0, pocketOre: 0,
    nearChestId: null, nearBarrelId: null, nearShipId: null, carryingChestId: null,
    bucketFilled: false, gold: 0, armor: 0, treasureMapIslandId: null, hasShovel: false,
  };
  const view = {
    ui: { interactPrompt: { style: {}, dataset: {}, textContent: '', addEventListener() {} } },
    state: { players: [player], ships: [ship], islands: [], kegs: [] },
    barrelBrowse: null, tavernDoors: [], visibleInteractKind: null, lastInteractKind: null,
    mermaidAnchor: null, pendingInteractFromUi: false, pendingLaunchFromUi: false,
    createMermaidAnchor: () => ({ x: 0, z: 0, shipId: ship.id }),
    findChestById: () => null,
    findHarvestTarget: () => null,
    findNearbyKeg: () => null,
    findRepairableHole: () => null,
    getBarrelWorldPoint: () => null,
    getChestWorldPoint: () => null,
    getInventoryQty: () => 0,
    getLocalPlayer: () => player,
    getLookDirection: (p) => new THREE.Vector3(
      Math.sin(p.rotation.x) * Math.cos(p.rotation.y),
      Math.sin(p.rotation.y),
      Math.cos(p.rotation.x) * Math.cos(p.rotation.y),
    ).normalize(),
    getMermaidReturnShip: () => null,
    getNearbyGoldHoarder: () => null,
    getNearbyUpgradeStation: () => null,
    getRepairPlankCount: () => 0,
    getHoleRepairWorldPoint: () => new THREE.Vector3(),
    getShipReachPoint: (s, lx, lz, worldY) => {
      const w = toShipWorldPoint({ x: lx, z: lz }, s);
      return new THREE.Vector3(w.x, s.position.y + worldY, w.z);
    },
    getTavernDoorWorldPoint: (door, out) => out,
    getTrackedShip: () => ship,
    getUpgradePresentation: () => ({ name: '', short: '', icon: '', color: '', hex: 0, effect: '' }),
  };
  return { ship, player, view };
}

const STEP = 0.25;
const YAWS = 8;

console.log('\nPrompt ⊆ grant, 0.25 m deck grid × 8 yaws × 3 hulls');
for (const type of ['sloop', 'brigantine', 'galleon']) {
  const { ship, player, view } = makeRig(type);
  const stats = SHIP_STATS[type];
  let squares = 0;
  let offers = 0;
  const broken = new Map();
  for (let lx = -stats.width / 2; lx <= stats.width / 2 + 1e-9; lx += STEP) {
    for (let lz = -stats.length / 2; lz <= stats.length / 2 + 1e-9; lz += STEP) {
      const w = toShipWorldPoint({ x: lx, z: lz }, ship);
      player.position.x = w.x;
      player.position.z = w.z;
      player.position.y = getShipFloorYAt({ x: w.x, y: ship.position.y + stats.height + 4, z: w.z }, ship) + 0.02;
      if (!isStandingOnShipDeck(player, ship)) continue;
      squares += 1;
      for (let i = 0; i < YAWS; i += 1) {
        player.rotation.x = ship.rotation + (i * Math.PI * 2) / YAWS;
        player.rotation.y = 0;
        // Fresh arbiter per sample: the 40 ms memo and the sticky winner are
        // frame-to-frame devices, and a grid walk is not a frame sequence.
        const offer = new InteractionPrompts(view).getLookInteraction(player, ship, findNearbyCannonIndex(player, ship), null);
        const grant = offer ? GRANTS[offer.kind] : null;
        if (!offer || !grant) continue;
        offers += 1;
        if (grant(player, ship)) continue;
        const rec = broken.get(offer.kind) ?? { n: 0, worst: null };
        rec.n += 1;
        if (!rec.worst) rec.worst = `local (${lx.toFixed(2)}, ${lz.toFixed(2)}) yaw ${i} → "${offer.prompt}"`;
        broken.set(offer.kind, rec);
      }
    }
  }
  const detail = [...broken.entries()].map(([kind, r]) => `${kind}: ${r.n} lying offers · e.g. ${r.worst}`).join('\n     ');
  expect(`${type}: every station prompt is granted (${squares} deck squares, ${offers} station offers)`,
    broken.size === 0, detail);
}

console.log(failures === 0 ? '\nPASS interact parity' : `\nFAIL interact parity (${failures})`);
process.exit(failures === 0 ? 0 : 1);
