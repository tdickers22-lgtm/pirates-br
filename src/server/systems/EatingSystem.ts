/**
 * EatingSystem (D21, b3.5a / mechanicshud-03).
 *
 * Eating used to be instant and chainable: `health += 25` the tick the wheel
 * slot was pressed, the item gone even at full health, so four bananas were
 * +100 HP in 2.6 s in the middle of a gunfight. Now a heal costs time and
 * exposure, the Sea of Thieves way:
 *
 *   1. EAT ACTION, 0.9 s. The weapon is lowered and the pirate moves at 70 %.
 *      Firing (or swinging) cancels it, and so does TAKING a station (helm,
 *      cannon, capstan, crow's nest). Damage does not. A cancelled eat keeps
 *      the item: food is only consumed when the action completes.
 *   2. HEAL OVER TIME after the bite: banana 20 HP over 1.2 s, coconut/mango
 *      22 over 1.5 s, meat its species value over 2.0 s. One heal runs at a
 *      time; a second bite taken while one is running queues behind it.
 *   3. REFUSED AT FULL HEALTH: when health plus every heal still owed would
 *      already reach MAX_HEALTH, the eat is refused ('health_full') and the
 *      item is kept.
 *
 * Server-only state (Map by player id), no rng, no wall clock: every number
 * here is a pure function of the ticks it is fed, so a replay is identical.
 * Bots and humans reach it through the same `begin` call.
 */
import { PLAYER } from '../../shared/constants/index.js';
import type { Player } from '../../shared/types/index.js';

export const EATING = {
  /** Seconds the bite takes before the food is consumed and the heal starts. */
  ACTION_TIME: 0.9,
  /** Ground speed while the bite is in progress. */
  MOVE_SCALE: 0.7,
  BANANA_HEAL: 20,
  BANANA_OVER: 1.2,
  /** Coconut and mango. */
  FRUIT_HEAL: 22,
  FRUIT_OVER: 1.5,
  /** Meat heals its species value (WILDLIFE.MEAT_HEAL) or POCKET.MEAT_HEAL. */
  MEAT_OVER: 2.0,
} as const;

export type EatItem = 'banana' | 'coconut' | 'mango' | 'meat';

export interface EatRequest {
  item: EatItem;
  /** Total HP this food gives over `over` seconds. */
  heal: number;
  over: number;
  /** Takes the food out of the pocket / larder at the END of the bite. Returns
   *  false when it is no longer there (the larder was emptied by a crewmate),
   *  in which case nothing heals. */
  consume: () => boolean;
}

/** Why `begin` said no. */
export type EatRefusal = 'health_full' | 'busy' | 'dead';

interface EatAction {
  req: EatRequest;
  left: number;
  /** Was the pirate at a station on the last check: TAKING one cancels, being
   *  at one when the bite started does not. */
  atStation: boolean;
}

interface HealOverTime {
  item: EatItem;
  /** HP per second. */
  rate: number;
  /** HP still to give. */
  left: number;
}

type StationFlags = Pick<Player, 'atHelm' | 'atCannon' | 'atCrowNest'> & { atCapstan?: boolean };

export function isAtStation(p: StationFlags): boolean {
  return !!(p.atHelm || p.atCannon || p.atCrowNest || p.atCapstan);
}

/** The heal a food gives, per D21. `meatHeal` is the species (or generic) value. */
export function eatRequestFor(item: EatItem, consume: () => boolean, meatHeal = 0): EatRequest {
  switch (item) {
    case 'banana': return { item, heal: EATING.BANANA_HEAL, over: EATING.BANANA_OVER, consume };
    case 'coconut':
    case 'mango': return { item, heal: EATING.FRUIT_HEAL, over: EATING.FRUIT_OVER, consume };
    case 'meat': return { item, heal: meatHeal, over: EATING.MEAT_OVER, consume };
  }
}

type EaterState = Pick<Player, 'id' | 'health' | 'state'>;

export class EatingSystem {
  private readonly actions = new Map<string, EatAction>();
  private readonly heals = new Map<string, HealOverTime[]>();
  /** Why the last `begin` was refused. */
  lastRefusal: EatRefusal | null = null;

  isEating(playerId: string): boolean {
    return this.actions.has(playerId);
  }

  /** Seconds left on the bite, 0 when not eating. */
  actionLeft(playerId: string): number {
    return this.actions.get(playerId)?.left ?? 0;
  }

  /** HP still owed: the bite in progress plus every queued heal. */
  pendingHeal(playerId: string): number {
    let owed = this.actions.get(playerId)?.req.heal ?? 0;
    for (const h of this.heals.get(playerId) ?? []) owed += h.left;
    return owed;
  }

  /** Start a bite. False (and `lastRefusal`) when refused; the food is untouched. */
  begin(player: EaterState & StationFlags, req: EatRequest): boolean {
    this.lastRefusal = null;
    if (player.state === 'eliminated' || player.state === 'respawning') {
      this.lastRefusal = 'dead';
      return false;
    }
    if (this.actions.has(player.id)) {
      this.lastRefusal = 'busy';
      return false;
    }
    if (player.health + this.pendingHeal(player.id) >= PLAYER.MAX_HEALTH - 1e-6) {
      this.lastRefusal = 'health_full';
      return false;
    }
    this.actions.set(player.id, { req, left: EATING.ACTION_TIME, atStation: isAtStation(player) });
    return true;
  }

  /** Drop the bite in progress without consuming the food. True if one was running. */
  cancel(playerId: string): boolean {
    return this.actions.delete(playerId);
  }

  /** Once per tick after the pirate's input is applied: the trigger or taking a
   *  station ends the bite (the food is kept). Damage never reaches here. */
  interrupt(player: Pick<Player, 'id'> & StationFlags, firing: boolean): boolean {
    const action = this.actions.get(player.id);
    if (!action) return false;
    const atStation = isAtStation(player);
    if (firing || (atStation && !action.atStation)) {
      this.actions.delete(player.id);
      return true;
    }
    action.atStation = atStation;
    return false;
  }

  /** Advance the bite and the heal queue by one tick. */
  tick(player: EaterState, dt: number): void {
    if (player.state === 'eliminated' || player.state === 'respawning') {
      this.forget(player.id);
      return;
    }
    const action = this.actions.get(player.id);
    if (action) {
      action.left -= dt;
      if (action.left <= 1e-9) {
        this.actions.delete(player.id);
        if (action.req.consume() && action.req.heal > 0) {
          const queue = this.heals.get(player.id) ?? [];
          queue.push({ item: action.req.item, rate: action.req.heal / Math.max(1e-3, action.req.over), left: action.req.heal });
          this.heals.set(player.id, queue);
        }
      }
    }
    const queue = this.heals.get(player.id);
    if (!queue || queue.length === 0) return;
    let budget = dt;
    while (budget > 1e-9 && queue.length > 0) {
      const head = queue[0];
      const need = head.left / head.rate;
      const used = Math.min(budget, need);
      const give = used >= need ? head.left : head.rate * used;
      head.left -= give;
      budget -= used;
      player.health = Math.min(PLAYER.MAX_HEALTH, player.health + give);
      if (head.left <= 1e-9) queue.shift();
    }
    // Food never over-heals: at full health whatever is still owed is gone.
    if (player.health >= PLAYER.MAX_HEALTH) queue.length = 0;
    if (queue.length === 0) this.heals.delete(player.id);
  }

  /** Death, respawn or leaving the match. */
  forget(playerId: string): void {
    this.actions.delete(playerId);
    this.heals.delete(playerId);
  }
}
