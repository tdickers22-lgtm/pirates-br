/**
 * b4.7b ClimbSystem: the one climb verb. Generalises the mast ladder
 * (Match.startMastClimb) to the island routes placed by
 * world/placement/climbs.ts (ladders, ropes, scramble corridors).
 *
 * No parallel state: Player.mastClimb is THE climb progress (0 foot .. 1 top)
 * for every route, so every client path that already reads it (climb pose,
 * holstered viewmodel, hidden [X] candidates, rung footsteps, eye bob off)
 * follows an island climb unchanged. The only extra server state is which
 * island route a climber is on; no entry means the mast ladder (ship space,
 * pinned by PhysicsSystem as before).
 *
 * Island routes: up CLIMB_UP_MPS, down CLIMB_DOWN_MPS along the draped
 * polyline, no sideways travel. The body cannot leave the face except by the
 * jump-off ([X] or jump), which throws it CLIMB_JUMP_OFF_M clear of the face;
 * reaching an end with the stick still pushing that way steps off onto the
 * ground there. `pin` runs right after PhysicsSystem.update so the body sits on
 * the route in every snapshot.
 */
import type { Island, Player, PlayerInput, Ship } from '../../shared/types/index.js';
import {
  climbJumpOff, climbPointAt, findClimbMount, stepClimbProgress, type IslandClimb,
} from '../../shared/interactions.js';

/** Mast ladder climb rate: fraction of the full ladder per second (W up, S down). */
export const MAST_CLIMB_RATE = 0.55;

export class ClimbSystem {
  private readonly routes = new Map<string, IslandClimb>();
  /** Last stick direction per climber (rung footsteps read velocity.y). */
  private readonly dir = new Map<string, number>();

  /** The island route a climber is on, or null (mast ladder or not climbing). */
  routeOf(player: Player): IslandClimb | null {
    return player.mastClimb !== null ? this.routes.get(player.id) ?? null : null;
  }

  /** Mount the mast ladder at its base (Match.startMastClimb decides who may). */
  mountMast(player: Player): void {
    this.routes.delete(player.id);
    player.mastClimb = 0;
  }

  /** [X] at an island route's foot or top. Bots have no route AI yet. */
  tryMount(player: Player, islands: readonly Island[]): boolean {
    if (player.isBot || player.state !== 'alive' || player.onShipId || player.mastClimb !== null) return false;
    const m = findClimbMount(islands, player.position.x, player.position.y, player.position.z);
    if (!m) return false;
    this.routes.set(player.id, m.climb);
    this.dir.set(player.id, 0);
    player.mastClimb = m.t;
    this.place(player, m.climb, m.t);
    return true;
  }

  /**
   * Captive climb input (moved from Match.applyInput). `letGo` = this tick's
   * one-shot [X]. Mast: [X] lets go to the deck, W/S slide, the top hands off
   * to the walkable nest. Island route: [X] or jump = jump-off, W/S climb.
   */
  applyInput(player: Player, input: PlayerInput, ship: Ship | null | undefined, dt: number, letGo: boolean): void {
    if (player.mastClimb === null) return;
    const climbDir = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const route = this.routes.get(player.id);
    if (route) {
      if (letGo || input.jumpPressed) { this.jumpOff(player, route); return; }
      const t = stepClimbProgress(route, player.mastClimb, climbDir, dt);
      this.dir.set(player.id, climbDir);
      if ((t >= 1 && climbDir > 0) || (t <= 0 && climbDir < 0)) {
        this.release(player);
        this.place(player, route, t >= 1 ? 1 : 0);
        return;
      }
      player.mastClimb = t;
      return;
    }
    if (letGo) {
      player.mastClimb = null;
      return;
    }
    if (!ship || player.onShipId !== ship.id || ship.sinking) {
      player.mastClimb = null;
      return;
    }
    player.mastClimb = Math.max(0, Math.min(1, player.mastClimb + climbDir * MAST_CLIMB_RATE * dt));
    if (player.mastClimb >= 1) {
      // Top of the ladder: step into the (walkable) basket.
      player.mastClimb = null;
      player.atCrowNest = true;
    } else if (player.mastClimb <= 0 && climbDir < 0) {
      // Back at the base: release standing on deck at the ladder foot.
      player.mastClimb = null;
    }
  }

  /** After PhysicsSystem.update: island climbers sit on their route. A climber
   *  whose climb ended elsewhere (station reset, death) loses the route; a
   *  downed climber falls. */
  pin(players: readonly Player[]): void {
    for (const player of players) {
      const route = this.routes.get(player.id);
      if (!route) continue;
      if (player.mastClimb === null || player.onShipId) { this.release(player); continue; }
      if (player.state !== 'alive') { this.release(player); continue; }
      this.place(player, route, player.mastClimb);
      const d = this.dir.get(player.id) ?? 0;
      player.velocity.y = d > 0 ? 2.4 : d < 0 ? -3.2 : 0;
    }
  }

  forget(playerId: string): void {
    this.routes.delete(playerId);
    this.dir.delete(playerId);
  }

  private jumpOff(player: Player, route: IslandClimb): void {
    const j = climbJumpOff(route, player.mastClimb ?? 0);
    this.release(player);
    player.position.x = j.position.x; player.position.y = j.position.y; player.position.z = j.position.z;
    player.velocity.x = j.velocity.x; player.velocity.y = j.velocity.y; player.velocity.z = j.velocity.z;
  }

  private release(player: Player): void {
    player.mastClimb = null;
    this.forget(player.id);
  }

  private place(player: Player, route: IslandClimb, t: number): void {
    const p = climbPointAt(route, t);
    player.position.x = p.x; player.position.y = p.y; player.position.z = p.z;
    player.velocity.x = 0; player.velocity.y = 0; player.velocity.z = 0;
    player.knockbackVelocity.x = 0; player.knockbackVelocity.y = 0; player.knockbackVelocity.z = 0;
  }
}
