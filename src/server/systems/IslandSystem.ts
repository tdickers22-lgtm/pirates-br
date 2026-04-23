import type { Island, Player, ItemStack, Ship, WeaponId } from '../../shared/types/index.js';
import { PLAYER, WEAPONS } from '../../shared/constants/index.js';

export interface BarrelOpenEvent {
  playerId: string;
  barrelId: string;
  loot: ItemStack[];
}

export class IslandSystem {
  tryOpenBarrel(player: Player, islands: Island[], ships: Ship[]): BarrelOpenEvent | null {
    if (!player.nearBarrelId) return null;
    for (const island of islands) {
      for (const barrel of island.barrels) {
        if (barrel.id === player.nearBarrelId && !barrel.opened) {
          const dx = player.position.x - barrel.position.x;
          const dz = player.position.z - barrel.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE) {
            barrel.opened = true;
            this.distributeToPlayer(player, barrel.loot, ships);
            return { playerId: player.id, barrelId: barrel.id, loot: barrel.loot };
          }
        }
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
      flintlock_ammo: 'flintknock',
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
    let worst: 0 | 1 | 2 | 3 = 0;
    let worstScore = Infinity;
    for (let i = 0; i < player.weapons.length; i++) {
      const w = player.weapons[i];
      if (!w || WEAPONS[w.weaponId].melee) continue;
      const score = w.ammo + w.reserve;
      if (score < worstScore) {
        worstScore = score;
        worst = i as 0 | 1 | 2 | 3;
      }
    }
    return worstScore < Infinity ? worst : null;
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
