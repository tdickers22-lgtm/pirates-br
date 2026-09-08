// One Player record, fully populated, for logic suites that drive the REAL
// PhysicsSystem. Every physics suite used to carry its own 60-line literal and
// they drifted: test-geyser's copy predated `hasShovel`, so a suite that added
// a field silently exercised a different body than the server does. One factory,
// one place to add a field.
import { PLAYER } from '../../src/shared/constants/index.ts';

let seq = 0;

export function makeTestPlayer(position, overrides = {}) {
  seq += 1;
  return {
    id: `test-player-${seq}`,
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
