# Pirates BR — Full Polish Pass Design
**Date:** 2026-04-16

## Scope
Bug fixes, weapon changes, new island upgrade system, inventory HUD, and visual/performance polish.

---

## 1. X Key Priority Bug Fix

**Root cause:** `applyInput` checks for a nearby keg before checking `player.atCannon/atHelm/atSails`. Pressing X to leave a station fails if a keg is within diffuse range.

**Fix:** Reorder the interact block:
1. If `player.atCannon || player.atHelm || player.atSails` → exit station, return
2. Keg diffuse (if near keg on enemy ship)
3. Chest open
4. Board ship
5. Enter hatch
6. Toggle anchor
7. Enter sails
8. Enter helm
9. Enter cannon
10. Repair hull section

---

## 2. Cannon Movement (SoT-style)

**Server:** `getCannonAim` already constrains yaw ±75.6° from broadside, pitch −9.2° to 35.5°. No change needed.

**Client:** `ShipRenderer` must read which player is at which cannon from the snapshot and rotate the cannon barrel mesh to match that player's `rotation.x` (yaw) and `rotation.y` (pitch). Camera when at cannon locks to cannon pivot with the same look sensitivity.

**Aim reticle:** Render a small crosshair overlay (distinct from default) while at cannon.

---

## 3. Cannon Self-Launch Fix

**Root cause:** `ship.cannonCooldowns` array must be initialized to `new Array(cannonCount).fill(0)` at ship spawn. Verify this in `MapGenerator`. Additionally, remove the cooldown gate from launch — launch via Space is always available when `player.atCannon`. The cooldown only blocks firing a projectile, not human launch.

```
// Before
if (player.atCannon && input.jumpPressed && ship.cannonCooldowns[cannonIndex] <= 0)

// After  
if (player.atCannon && input.jumpPressed)
```

---

## 4. Second Keg 60-Second Cooldown

Add `kegCooldown: number` (default 0) to `Player` type.

When `player.kegs` transitions from 1 → 0 after placing: set `kegCooldown = 60`.

Server tick: `if (player.kegCooldown > 0) player.kegCooldown -= dt`.

Block placement: `input.placeKeg && player.kegs > 0 && player.kegCooldown <= 0`.

HUD: show keg count; if `kegCooldown > 0` show `⏱ 60s` countdown instead of keg icon.

---

## 5. Ship Repair — More Intuitive

- Move repair check to _before_ station-enter checks in the interact priority (still after "exit station")
- Repair prompt: `[X] Repair Bow — 1 plank (you have N)`
- Show which sections are damaged in hull HUD with directional arrows
- If ship has no planks: show `⚠ No planks — find some on islands`
- Auto-context: `getRepairableHullSection` already finds nearest damaged section, just make the prompt clearer

---

## 6. Inventory Bar HUD

New fixed bar at bottom-center of screen showing ship inventory:

| Icon | Item | Qty |
|------|------|-----|
| 🪵 | Wood Planks | N |
| 💣 | Cannonballs | N |
| 🔥 | Firebombs | N |
| ⛓ | Chainshot | N |
| 🍌 | Bananas | N |

Player kegs shown bottom-right with cooldown timer overlay.

Visible at all times when on a ship. Hidden when swimming.

---

## 7. Flintlock → Flintknock

- Change starting weapon from `flintlock` to `flintknock`
- Update `chooseWeaponSlotForUnlock` (IslandSystem line 90): `flintlock` → `flintknock`
- Loot table: `flintlock_ammo` weight drops to 0, `flintknock_ammo` weight increases to 18
- `flintknock` self-knockback already implemented (WeaponSystem lines 98–108)
- Display name in HUD: "Flintknock Pistol" with knockback icon

Keep `flintlock` in `WeaponId` union and `WEAPONS` for backward compatibility but don't spawn it.

---

## 8. Blunderbuss

Already defined in constants with correct stats (12 dmg × 7 pellets, 6° spread, 20 range). Already in loot table.

Fix needed:
- `chooseWeaponSlotForUnlock` line 91 checks `player.weapons[1]?.weaponId === 'blunderbuss'` for slot 1 replacement — this is correct, keep it
- Add weapon icon rendering for blunderbuss in weapon HUD slots
- Ensure bots can spawn with blunderbuss as an alternative to pistol

---

## 9. Island Upgrades

### New Types

```ts
export type ShipUpgradeType = 'hull_reinforcement' | 'charged_cannons' | 'swift_sails';

export interface ShipUpgrade {
  type: ShipUpgradeType;
  level: number; // always 1 (no stacking of same type)
}

export interface UpgradeStation {
  id: string;
  type: ShipUpgradeType;
  position: Vec3;
  claimedByShipId: string | null;
}
```

Add `upgrades: ShipUpgrade[]` to `Ship`.
Add `upgradeStations: UpgradeStation[]` to `Island`.

### Station Spawning
Each island gets 1–2 upgrade stations (determined by island radius). Station types distributed so not all islands have the same type. Stations positioned near the dock or on the island beach.

### Upgrade Effects (applied via multipliers)
| Type | Effect |
|------|--------|
| `hull_reinforcement` | ×1.25 `maxHull` per section; existing HP scales proportionally |
| `charged_cannons` | ×1.30 `CANNON_DAMAGE_HULL` and `CANNON_DAMAGE_PLAYER` |
| `swift_sails` | ×1.20 `maxSpeed` |

Effects applied in `PhysicsSystem` (speed) and `WeaponSystem` (cannon damage) by reading `ship.upgrades`.

### Interaction
Player walks near station (within `PLAYER.INTERACT_RANGE`), presses X. Server checks:
1. Player is on a ship (`player.onShipId`)
2. Ship doesn't already have this upgrade type
3. Station not already claimed by another ship

On success: add upgrade to ship, mark station `claimedByShipId`, broadcast `ship_upgraded` event.

### Visual Feedback
- **Pennant flags on mast:** Each upgrade adds a colored pennant below the ship's main sail — blue (hull), red (cannon), gold (speed). Rendered as a small triangular mesh in `ShipRenderer`.
- **Upgrade station model:** Glowing forge anvil mesh on island, dims/turns grey when claimed.
- **HUD upgrade badges:** Small icons in the ship status panel showing active upgrades.

---

## 10. Performance + Visual Polish

| Fix | Impact |
|-----|--------|
| Shadow map 1024→512 | ~15% GPU reduction |
| Frustum-cull island detail meshes >400 units | Reduces draw calls on large maps |
| Minimap redraw throttle 100ms→250ms | Saves canvas rasterization |
| Cannon fire muzzle flash particle | Visual feel |
| Glass-morphism HUD panels | Visual quality |
| Cannon aim reticle (distinct from gun crosshair) | Clarity |
| Fix `jump` input not being properly cleared causing sticky jump | Correctness |

---

## Files Changed

| File | Changes |
|------|---------|
| `src/shared/types/index.ts` | Add `kegCooldown`, `upgrades` to Player/Ship; add `UpgradeStation`, `ShipUpgrade` types |
| `src/shared/constants/index.ts` | Add upgrade multiplier constants; reweight loot table |
| `src/server/core/GameServer.ts` | Fix X key priority; fix cannon launch; add keg cooldown; add upgrade interaction |
| `src/server/systems/WeaponSystem.ts` | Apply cannon damage upgrade multiplier |
| `src/server/systems/PhysicsSystem.ts` | Apply speed upgrade multiplier |
| `src/server/systems/IslandSystem.ts` | Update slot preference; add upgrade station spawning |
| `src/server/world/MapGenerator.ts` | Spawn upgrade stations on islands; verify cannonCooldowns init |
| `src/client/core/Game.ts` | Inventory bar HUD; keg cooldown HUD; upgrade badge HUD; repair prompts; cannon reticle |
| `src/client/rendering/ShipRenderer.ts` | Cannon barrel rotation; pennant flags; upgrade station forge mesh |
| `src/client/rendering/Renderer.ts` | Shadow map reduction; fog/sky tuning |
