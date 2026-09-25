// b2.2f (holes-07): the flooded hold is water for the player.
//
// PhysicsSystem calls applyHoldWater for every pirate aboard (not at the helm,
// a cannon or the crow's nest) BEFORE the gravity step. The water is read from
// the shared sampler (src/shared/flooding/hullVolume.ts sampleHoldWater: fill
// table + the live roll/pitch tilt at the pirate's x, z), so a client predictor
// that calls the same function gets the same mode and the same speed cap.
//
//  - dry  (depth < 0.35 body heights): nothing changes.
//  - wade (0.35..0.75): the walk step Match already applied is cut back to
//    HOLD_WADE_SPEED_SCALE of the dry walk (a speed CAP, so the ground
//    acceleration cannot compound it the way a per-tick multiply would).
//  - swim (> 0.75): off his feet. Gravity is replaced by buoyancy that floats
//    the eye just above the surface, under the deck lid (the companionway
//    mouth is open, so he can come up there and the treads lift him out);
//    horizontal speed is capped at HOLD_SWIM_SPEED_SCALE and a stroke drag lets
//    him drift to a stop. Breath runs on the drowning clock (swimTimer /
//    PLAYER.DROWN_TIME), faster with his head under.
//
// The pirate stays 'alive' and aboard (onShipId), so repair and the bucket keep
// working with the water over his waist: the open-water swim branch would push
// him out through the hull.
import type { Player, Ship } from '../../shared/types/index.js';
import { PLAYER, SHIP_STATS } from '../../shared/constants/index.js';
import { shipLocalUpY } from '../../shared/interactions.js';
import { getShipCompanionwayConfig } from '../../shared/utils/index.js';
import { getHullVolumeTable, holdSpeedCap, sampleHoldWater, type HoldWaterMode } from '../../shared/flooding/hullVolume.js';

/** Afloat, the eye rides this far above the surface. */
export const HOLD_FLOAT_EYE_CLEAR = 0.12;
/** The head stops this far under the deck beams. */
export const HOLD_HEAD_CLEAR = 0.05;
/** Buoyancy spring (rad/s, critically damped) toward the float line. */
export const HOLD_FLOAT_OMEGA = 3;
/** Stroke drag while afloat (1/s): a swimmer who lets go drifts to a stop. */
export const HOLD_SWIM_DRAG = 1.5;
/** The drowning clock runs this much faster with the head under water. */
export const HOLD_BREATH_UNDER_RATE = 4;

export interface HoldWaterResult {
  mode: HoldWaterMode;
  immersion: number;
  headUnder: boolean;
}

type HoldPlayer = Pick<Player, 'position' | 'velocity' | 'crouching' | 'swimTimer' | 'health' | 'respawnProtectionTimer' | 'lastEnvDamage' | 'lastDamageWasHeadshot'>;

export function applyHoldWater(player: HoldPlayer, ship: Ship, dt: number, t: number): HoldWaterResult {
  const sample = sampleHoldWater(player.position, ship);
  const { mode, immersion, surfaceLocalY, floorLocalY, local } = sample;
  if (mode === 'dry' || surfaceLocalY == null) return { mode: 'dry', immersion, headUnder: false };

  // Horizontal: cap the deck-relative walk this tick already applied.
  const cap = holdSpeedCap(mode, player.crouching);
  const vx = player.velocity.x;
  const vz = player.velocity.z;
  const v = Math.hypot(vx, vz);
  let keep = v > cap ? cap / v : 1;
  if (mode === 'swim') keep *= Math.exp(-HOLD_SWIM_DRAG * dt);
  if (keep < 1) {
    player.position.x -= vx * dt * (1 - keep);
    player.position.z -= vz * dt * (1 - keep);
    player.velocity.x = vx * keep;
    player.velocity.z = vz * keep;
  }
  if (mode === 'wade') return { mode, immersion, headUnder: false };

  // Afloat: buoyancy to the float line instead of gravity.
  const stats = SHIP_STATS[ship.type];
  const deckY = getHullVolumeTable(ship.type).deckY;
  const stair = getShipCompanionwayConfig(stats);
  const inMouth = Math.abs(local.x - stair.cx) <= stair.stairHalfWidth
    && local.z >= Math.min(stair.stairBackZ, stair.stairFrontZ)
    && local.z <= Math.max(stair.stairBackZ, stair.stairFrontZ);
  let restLocal = surfaceLocalY + HOLD_FLOAT_EYE_CLEAR - PLAYER.EYE_Y;
  if (!inMouth) restLocal = Math.min(restLocal, deckY - HOLD_HEAD_CLEAR - PLAYER.HEIGHT);
  restLocal = Math.max(restLocal, floorLocalY);
  const restY = ship.position.y + shipLocalUpY(local.x, restLocal, local.z, ship);
  const yBefore = player.position.y;
  const w = HOLD_FLOAT_OMEGA;
  const off = restY - player.position.y;
  player.velocity.y += (w * w * off - 2 * w * player.velocity.y) * dt;
  player.position.y += player.velocity.y * dt;

  // Breath: the drowning clock, faster with the head under.
  const eyeLocal = local.y + (player.position.y - yBefore) + PLAYER.EYE_Y;
  const headUnder = eyeLocal < surfaceLocalY;
  player.swimTimer = (player.swimTimer ?? 0) + dt * (headUnder ? HOLD_BREATH_UNDER_RATE : 1);
  if (player.swimTimer > PLAYER.DROWN_TIME && player.respawnProtectionTimer <= 0) {
    player.lastEnvDamage = { cause: 'drowned', at: t };
    player.lastDamageWasHeadshot = false;
    player.health -= PLAYER.DROWN_DAMAGE * dt;
  }
  return { mode, immersion, headUnder };
}
