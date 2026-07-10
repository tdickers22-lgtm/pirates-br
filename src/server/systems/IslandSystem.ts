import type { Island, IslandBarrel, Player, ItemStack, Ship, WeaponId } from '../../shared/types/index.js';
import { PLAYER, WEAPONS } from '../../shared/constants/index.js';

export interface BarrelOpenEvent {
  playerId: string;
  barrelId: string;
  loot: ItemStack[];
  /** When true the player took the contents in this event; otherwise it's just an open/inspect. */
  taken: boolean;
}

export class IslandSystem {
  /** First interact: open the barrel for inspection (no transfer). Second interact:
   *  transfer everything to the player/ship and clear the barrel. Returns null when
   *  the player isn't actually next to a barrel. */
  tryOpenBarrel(player: Player, islands: Island[], ships: Ship[]): BarrelOpenEvent | null {
    if (!player.nearBarrelId) return null;
    const barrel = this.findNearbyBarrel(player, islands);
    if (!barrel) return null;
    if (!barrel.opened) {
      barrel.opened = true;
      // Snapshot the loot so the client can render the panel — barrel.loot stays
      // intact until a take-all action.
      return { playerId: player.id, barrelId: barrel.id, loot: barrel.loot.map((s) => ({ ...s })), taken: false };
    }
    return this.takeAllFromBarrel(player, barrel, ships);
  }

  tryTakeAllFromNearbyBarrel(player: Player, islands: Island[], ships: Ship[]): BarrelOpenEvent | null {
    if (!player.nearBarrelId) return null;
    const barrel = this.findNearbyBarrel(player, islands);
    if (!barrel) return null;
    if (!barrel.opened) {
      // Open + take in one go for users who hit the take-all shortcut without browsing first.
      barrel.opened = true;
    }
    return this.takeAllFromBarrel(player, barrel, ships);
  }

  private takeAllFromBarrel(player: Player, barrel: IslandBarrel, ships: Ship[]): BarrelOpenEvent {
    const loot = barrel.loot.map((s) => ({ ...s }));
    this.distributeToPlayer(player, barrel.loot, ships);
    barrel.loot = [];
    return { playerId: player.id, barrelId: barrel.id, loot, taken: true };
  }

  private findNearbyBarrel(player: Player, islands: Island[]): IslandBarrel | null {
    for (const island of islands) {
      for (const barrel of island.barrels) {
        if (barrel.id !== player.nearBarrelId) continue;
        const dx = player.position.x - barrel.position.x;
        const dz = player.position.z - barrel.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE) return barrel;
      }
    }
    return null;
  }

  private distributeToPlayer(player: Player, loot: ItemStack[], ships: Ship[]) {
    const destinationShip =
      ships.find((ship) => ship.id === player.onShipId && ship.alive) ??
      ships.find((ship) => ship.id === player.shipId && ship.alive) ??
      null;

    for (const stack of loot) {
      if (stack.item === 'gold') {
        player.gold += stack.qty;
        continue;
      }
      if (stack.item === 'banana') {
        player.pocketBanana += stack.qty;
        continue;
      }
      if (stack.item === 'coconut') {
        player.pocketCoconut += stack.qty;
        continue;
      }
      if (stack.item === 'mango') {
        player.pocketMango += stack.qty;
        continue;
      }
      if (stack.item === 'meat') {
        player.pocketMeat += stack.qty;
        continue;
      }
      if (stack.item.endsWith('_ammo')) {
        this.giveAmmoToPlayer(player, stack.item, stack.qty);
        continue;
      }
      if (stack.item === 'wood_plank') {
        if (destinationShip) {
          this.addItemToShipInventory(destinationShip, stack.item, stack.qty);
        } else {
          player.pocketWood += stack.qty;
        }
        continue;
      }
      if (destinationShip) {
        this.addItemToShipInventory(destinationShip, stack.item, stack.qty);
      }
    }
  }

  private giveAmmoToPlayer(player: Player, item: string, qty: number) {
    const ammoMap: Record<string, WeaponId> = {
      flintlock_ammo: 'flintlock',
      blunderbuss_ammo: 'blunderbuss',
      eye_ammo: 'eye_of_reach',
      flintknock_ammo: 'flintknock',
      pistol_ammo: 'pistol',
    };
    const weapId = ammoMap[item];
    if (weapId) {
      for (const w of player.weapons) {
        if (w && w.weaponId === weapId) {
          w.reserve = Math.min(WEAPONS[weapId].reserveMax, w.reserve + qty);
          return;
        }
      }

      const slot = this.chooseWeaponSlotForUnlock(player);
      if (slot !== null) {
        const def = WEAPONS[weapId];
        player.weapons[slot] = {
          weaponId: weapId,
          ammo: def.ammoMax,
          reserve: Math.min(def.reserveMax, qty),
          reloading: false,
          reloadTimer: 0,
        };
      }
    }
  }

  private chooseWeaponSlotForUnlock(player: Player): 0 | 1 | 2 | 3 | null {
    for (let i = 0; i < player.weapons.length; i++) {
      if (!player.weapons[i]) return i as 0 | 1 | 2 | 3;
    }
    // Never evict an equipped gun to make room for a new unlock — only unlock
    // into a genuinely empty slot. The matching-owned case is already handled
    // by the reserve credit in giveAmmoToPlayer before we get here.
    return null;
  }

  addItemToShipInventory(ship: Ship, item: ItemStack['item'], qty: number) {
    const existing = ship.inventory.find(s => s.item === item);
    if (existing) {
      existing.qty += qty;
    } else {
      ship.inventory.push({ item, qty });
    }
  }
}
