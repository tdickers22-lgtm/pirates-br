# Pirates BR — Full Polish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix X key priority bug, cannon launch, keg cooldown, flintlock→flintknock, add island upgrades, inventory bar HUD, cannon barrel rotation, upgrade visuals, and performance fixes.

**Architecture:** Server-side game logic changes in `GameServer.ts`, `WeaponSystem.ts`, `PhysicsSystem.ts`, `MapGenerator.ts`, `IslandSystem.ts`. Shared type/constant updates in `shared/`. Client HUD and rendering in `Game.ts`, `ShipRenderer.ts`, `Renderer.ts`.

**Tech Stack:** TypeScript, Three.js, Node.js WebSocket server, `uuid` for IDs.

---

## File Map

| File | What changes |
|------|-------------|
| `src/shared/types/index.ts` | Add `kegCooldown`, `upgrades` to Player/Ship; add `UpgradeStation`, `ShipUpgrade` types; add `ship_upgraded` to MsgType |
| `src/shared/constants/index.ts` | Add `SHIP_UPGRADES` constants; reweight flintknock loot; reweight flintlock loot to 0 |
| `src/server/systems/WeaponSystem.ts` | Change `createDefaultWeapons` to use `flintknock`; apply `charged_cannons` damage multiplier |
| `src/server/systems/PhysicsSystem.ts` | Apply `swift_sails` speed multiplier |
| `src/server/systems/IslandSystem.ts` | Update `chooseWeaponSlotForUnlock` to prefer `flintknock` in slot 0 |
| `src/server/world/MapGenerator.ts` | Spawn `upgradeStations` on islands; add `upgradeStations: []` to Island |
| `src/server/core/GameServer.ts` | Reorder X key interact block; remove cooldown gate from cannon launch; add keg cooldown tick + gate; add upgrade station interaction |
| `src/client/core/Game.ts` | Add inventory bar DOM + CSS; keg cooldown display; upgrade badge display; repair prompt improvements; minimap throttle 250ms |
| `src/client/rendering/ShipRenderer.ts` | Store barrel refs; update `ShipMeshGroup`; rotate cannon groups in `update()`; add upgrade pennants; add island forge mesh |
| `src/client/rendering/Renderer.ts` | Reduce shadow map to 512px |

---

## Task 1: Shared types + constants

**Files:**
- Modify: `src/shared/types/index.ts`
- Modify: `src/shared/constants/index.ts`

- [ ] **Step 1: Add upgrade types and update Player/Ship/Island/MsgType**

In `src/shared/types/index.ts`, add after the `ShipKeg` interface:

```typescript
export type ShipUpgradeType = 'hull_reinforcement' | 'charged_cannons' | 'swift_sails';

export interface ShipUpgrade {
  type: ShipUpgradeType;
}

export interface UpgradeStation {
  id: string;
  type: ShipUpgradeType;
  position: Vec3;
  claimedByShipId: string | null;
}
```

In the `Ship` interface (after `alive: boolean;`), add:
```typescript
  upgrades: ShipUpgrade[];
```

In the `Player` interface (after `cannonFlightTimer: number;`), add:
```typescript
  kegCooldown: number;
```

In the `Island` interface (after `chests: TreasureChest[];`), add:
```typescript
  upgradeStations: UpgradeStation[];
```

In `MsgType`, add `'ship_upgraded'` to the union.

- [ ] **Step 2: Add upgrade constants and reweight loot**

In `src/shared/constants/index.ts`, after the `SHIP` block, add:

```typescript
export const SHIP_UPGRADES = {
  HULL_HP_MULT: 1.25,
  CANNON_DAMAGE_MULT: 1.30,
  SWIFT_SPEED_MULT: 1.20,
  INTERACT_RANGE: 3.5,
} as const;
```

In `CHEST_LOOT_TABLE`, change:
- `flintlock_ammo` weight: `15` → `3`
- `flintknock_ammo` weight: `10` → `20`

- [ ] **Step 3: Commit**

```bash
cd /Users/tobiasdicker/pirates-br
git add src/shared/types/index.ts src/shared/constants/index.ts
git commit -m "feat: add upgrade types, kegCooldown field, reweight loot for flintknock"
```

---

## Task 2: Flintlock → Flintknock (server + loot system)

**Files:**
- Modify: `src/server/systems/WeaponSystem.ts:285-291`
- Modify: `src/server/systems/IslandSystem.ts:87-95`

- [ ] **Step 1: Change default weapons to flintknock**

In `src/server/systems/WeaponSystem.ts`, replace `createDefaultWeapons` (lines 285-291):

```typescript
createDefaultWeapons(): Player['weapons'] {
  return [
    { weaponId: 'flintknock' as WeaponId, ammo: 1, reserve: 5, reloading: false, reloadTimer: 0 },
    { weaponId: 'eye_of_reach' as WeaponId, ammo: 1, reserve: 5, reloading: false, reloadTimer: 0 },
    { weaponId: 'cutlass' as WeaponId, ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 },
  ];
}
```

- [ ] **Step 2: Update slot preference in IslandSystem**

In `src/server/systems/IslandSystem.ts`, replace `chooseWeaponSlotForUnlock` (lines 87-95):

```typescript
private chooseWeaponSlotForUnlock(player: Player): 0 | 1 | null {
  if (!player.weapons[0]) return 0;
  if (!player.weapons[1]) return 1;
  if (player.weapons[0]?.weaponId === 'flintknock') return 0;
  if (player.weapons[1]?.weaponId === 'blunderbuss') return 1;
  return player.weapons[0] && player.weapons[1] && player.weapons[0].reserve <= player.weapons[1].reserve
    ? 0
    : 1;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/systems/WeaponSystem.ts src/server/systems/IslandSystem.ts
git commit -m "feat: replace flintlock with flintknock as default starting weapon"
```

---

## Task 3: Fix X key priority + cannon launch + keg cooldown

**Files:**
- Modify: `src/server/core/GameServer.ts`

- [ ] **Step 1: Add kegCooldown to createPlayer**

In `src/server/core/GameServer.ts`, in `createPlayer` (around line 139), find `cannonFlightTimer: 0,` and add after it:

```typescript
      kegCooldown: 0,
```

- [ ] **Step 2: Add kegCooldown tick**

In the `tick()` method (around line 293), after `this.updateRespawns(dt);` add:

```typescript
    // Decrement keg cooldowns
    for (const player of this.state.players) {
      if (player.kegCooldown > 0) player.kegCooldown = Math.max(0, player.kegCooldown - dt);
    }
```

- [ ] **Step 3: Fix cannon launch — remove cooldown gate**

In `applyInput` (around line 423), replace:
```typescript
    if (ship && player.atCannon && input.jumpPressed && ship.cannonCooldowns[player.cannonIndex] <= 0) {
```
with:
```typescript
    if (ship && player.atCannon && input.jumpPressed) {
```

- [ ] **Step 4: Add keg cooldown gate to keg placement**

Replace the keg placement condition (around line 428):
```typescript
    if (input.placeKeg && ship && ship.id !== player.shipId && player.kegs > 0 && !player.atCannon && !player.atHelm && !player.atSails) {
```
with:
```typescript
    if (input.placeKeg && ship && ship.id !== player.shipId && player.kegs > 0 && player.kegCooldown <= 0 && !player.atCannon && !player.atHelm && !player.atSails) {
```

And after `player.kegs -= 1;` (around line 440), add:
```typescript
        if (player.kegs === 0) {
          player.kegCooldown = 60;
        }
```

- [ ] **Step 5: Fix X key priority — exit station first**

In `applyInput`, find the `if (input.interact) {` block (around line 445). Replace the ENTIRE block (from `if (input.interact) {` through the closing `}` of the interact block) with the reordered version:

```typescript
    // Interact (X key) — exit station takes priority over everything
    if (input.interact) {
      // 1. Exit current station first — always wins
      if (player.atCannon) {
        player.atCannon = false;
        return;
      }
      if (player.atHelm) {
        player.atHelm = false;
        return;
      }
      if (player.atSails) {
        player.atSails = false;
        return;
      }

      // 2. Diffuse nearby keg
      const keg = ship ? this.getNearbyKeg(player, ship) : null;
      if (keg) {
        this.diffuseKeg(keg);
        return;
      }

      // 3. Open chest
      if (player.nearChestId) {
        const event = this.islands.tryOpenChest(player, this.state.islands, this.state.ships);
        if (event) {
          this.broadcast({
            type: 'chest_opened',
            ts: Date.now(),
            payload: event,
          });
        }
        return;
      }

      // 4. Board nearby ship
      if (player.nearShipId && (player.state === 'swimming' || player.onShipId === null)) {
        const targetShip = this.state.ships.find(s => s.id === player.nearShipId && s.alive);
        if (targetShip) {
          const ladder = getNearestShipBoardingLadder(targetShip, player.position);
          if (!ladder) return;
          const stats = SHIP_STATS[targetShip.type];
          player.onShipId = targetShip.id;
          const boardPoint = this.toShipWorld(
            Math.sign(ladder.localX) * stats.width * 0.34,
            ladder.localZ + 0.18,
            targetShip,
          );
          player.position.x = boardPoint.x;
          player.position.z = boardPoint.z;
          player.position.y = targetShip.position.y + stats.height + 0.45;
          player.velocity.y = 0;
          player.state = 'alive';
          player.atCannon = false;
          player.atHelm = false;
          player.atSails = false;
          player.shipBoundaryGraceTimer = 0;
          player.cannonFlightTimer = 0;
          if (!targetShip.crewIds.includes(player.id)) targetShip.crewIds.push(player.id);
        }
        return;
      }

      // 5. On own ship: repair first (most urgent action), then stations, then environment
      if (ship) {
        // Repair damaged hull section — check before station entry
        const repairSection = this.getRepairableHullSection(player, ship);
        if (repairSection && this.consumeShipItem(ship, 'wood_plank', 1)) {
          this.physics.repairHullSection(ship, repairSection, SHIP.REPAIR_HP);
          if (ship.onFire) {
            ship.fireTimer = Math.max(0, ship.fireTimer - SHIP.FIRE_REPAIR_DOUSE_TIME);
            if (ship.fireTimer <= 0) {
              ship.onFire = false;
              ship.fireTimer = 0;
              ship.fireDamageAccum = 0;
            }
          }
          return;
        }

        // Upgrade station interaction
        const station = this.getNearbyUpgradeStation(player);
        if (station && station.claimedByShipId !== ship.id && !ship.upgrades.some(u => u.type === station.type)) {
          station.claimedByShipId = ship.id;
          this.applyShipUpgrade(ship, station.type);
          this.broadcast({ type: 'ship_upgraded', ts: Date.now(), payload: { shipId: ship.id, type: station.type } });
          return;
        }

        // Hatch
        if (this.isNearHatch(player, ship)) {
          this.useShipHatch(player, ship);
          return;
        }

        // Anchor
        if (this.isNearAnchor(player, ship)) {
          ship.anchored = !ship.anchored;
          player.atHelm = false;
          player.atCannon = false;
          player.atSails = false;
          return;
        }

        // Sails
        if (this.isNearSailControls(player, ship)) {
          player.atSails = true;
          player.atHelm = false;
          player.atCannon = false;
          this.snapPlayerToSails(player, ship);
          return;
        }

        // Helm
        const nearHelm = this.isNearHelm(player, ship);
        if (nearHelm) {
          player.atHelm = true;
          player.atCannon = false;
          player.atSails = false;
          this.snapPlayerToHelm(player, ship);
          return;
        }

        // Cannon
        const nearbyCannon = this.getNearbyCannonIndex(player, ship);
        if (nearbyCannon !== null) {
          player.atCannon = true;
          player.atHelm = false;
          player.atSails = false;
          player.cannonIndex = nearbyCannon;
          const aim = this.getCannonAim(ship, nearbyCannon, input.yaw, input.pitch);
          player.rotation.x = aim.yaw;
          player.rotation.y = aim.pitch;
          this.snapPlayerToCannon(player, ship, nearbyCannon);
        }
      }
    }
```

- [ ] **Step 6: Add getNearbyUpgradeStation and applyShipUpgrade helpers**

Add these private methods to `GameServer` (after `diffuseKeg`):

```typescript
  private getNearbyUpgradeStation(player: Player) {
    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const dx = player.position.x - station.position.x;
        const dz = player.position.z - station.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE) {
          return station;
        }
      }
    }
    return null;
  }

  private applyShipUpgrade(ship: Ship, type: ShipUpgrade['type']) {
    ship.upgrades.push({ type });
    if (type === 'hull_reinforcement') {
      const oldMax = ship.maxHull;
      ship.maxHull = Math.round(ship.maxHull * SHIP_UPGRADES.HULL_HP_MULT);
      // Scale current section HP proportionally
      const ratio = ship.maxHull / oldMax;
      ship.hull.bow      = Math.min(1, ship.hull.bow      * ratio);
      ship.hull.stern    = Math.min(1, ship.hull.stern    * ratio);
      ship.hull.port     = Math.min(1, ship.hull.port     * ratio);
      ship.hull.starboard = Math.min(1, ship.hull.starboard * ratio);
    }
  }
```

Also import `SHIP_UPGRADES` and `ShipUpgrade` at the top of `GameServer.ts`:

```typescript
import { SERVER_TICK_MS, SNAPSHOT_RATE, PLAYER, SHIP, SHIP_UPGRADES, SHIP_STATS, WEAPONS } from '../../shared/constants/index.js';
import type {
  GameState, IslandDock, Player, Projectile, Ship, ShipKeg, ShipUpgrade, Vec3, WeaponId, NetMsg, PlayerInput, TradeActionPayload,
} from '../../shared/types/index.js';
```

- [ ] **Step 7: Commit**

```bash
git add src/server/core/GameServer.ts
git commit -m "fix: X key priority, cannon launch, keg cooldown, upgrade station interaction"
```

---

## Task 4: Apply upgrade effects in PhysicsSystem + WeaponSystem

**Files:**
- Modify: `src/server/systems/PhysicsSystem.ts`
- Modify: `src/server/systems/WeaponSystem.ts`

- [ ] **Step 1: Speed multiplier in PhysicsSystem**

In `src/server/systems/PhysicsSystem.ts`, add this import at the top:

```typescript
import { PHYSICS, SHIP_STATS, SHIP, PLAYER, SHIP_UPGRADES } from '../../shared/constants/index.js';
```

In `updateShips`, find the `targetSpeed` calculation (around line 94-96):

```typescript
      const targetSpeed = ship.anchored
        ? 0
        : stats.maxSpeed * sailDeployment * (0.16 + trimEfficiency * 0.84) * windAssist * wind.strength * floodPenalty;
```

Replace with:
```typescript
      const speedMult = ship.upgrades.some(u => u.type === 'swift_sails') ? SHIP_UPGRADES.SWIFT_SPEED_MULT : 1;
      const targetSpeed = ship.anchored
        ? 0
        : stats.maxSpeed * speedMult * sailDeployment * (0.16 + trimEfficiency * 0.84) * windAssist * wind.strength * floodPenalty;
```

- [ ] **Step 2: Cannon damage multiplier in WeaponSystem**

In `src/server/systems/WeaponSystem.ts`, add this import at the top:

```typescript
import { WEAPONS, SHIP, SHIP_STATS, PLAYER, SHIP_UPGRADES } from '../../shared/constants/index.js';
```

In `fireShipCannon`, find `damage: SHIP.CANNON_DAMAGE_HULL,` (around line 247) and replace with:

```typescript
      damage: SHIP.CANNON_DAMAGE_HULL * (ship.upgrades.some(u => u.type === 'charged_cannons') ? SHIP_UPGRADES.CANNON_DAMAGE_MULT : 1),
```

- [ ] **Step 3: Commit**

```bash
git add src/server/systems/PhysicsSystem.ts src/server/systems/WeaponSystem.ts
git commit -m "feat: apply swift_sails speed and charged_cannons damage upgrade multipliers"
```

---

## Task 5: Island upgrade station spawning

**Files:**
- Modify: `src/server/world/MapGenerator.ts`

- [ ] **Step 1: Import UpgradeStation and ShipUpgradeType**

In `src/server/world/MapGenerator.ts`, update the import line:

```typescript
import type { Island, IslandDock, IslandProfile, TreasureChest, UpgradeStation, Vec3, Ship } from '../../shared/types/index.js';
```

- [ ] **Step 2: Add upgradeStations field to generated islands**

In `generateIslands()`, replace the `island` object construction (around line 41-48):

```typescript
      const island: Island = {
        id: uuid(),
        position: pos,
        radius,
        profile: this.generateIslandProfile(radius),
        dock: null,
        chests: [],
        upgradeStations: [],
      };
      island.dock = this.generateDock(island);
      island.chests = this.generateChests(island);
      island.upgradeStations = this.generateUpgradeStations(island);
```

- [ ] **Step 3: Add generateUpgradeStations method**

Add this private method to `MapGenerator` (after `generateChests`):

```typescript
  private generateUpgradeStations(island: Island): UpgradeStation[] {
    // Larger islands get 2 stations, smaller islands get 1 or 0
    const count = island.radius > 70 ? 2 : island.radius > 50 ? 1 : (Math.random() < 0.6 ? 1 : 0);
    if (count === 0) return [];

    const allTypes: Array<import('../../shared/types/index.js').ShipUpgradeType> = [
      'hull_reinforcement', 'charged_cannons', 'swift_sails',
    ];
    // Shuffle and pick `count` unique types
    const shuffled = [...allTypes].sort(() => Math.random() - 0.5);
    const types = shuffled.slice(0, count);

    return types.map(type => {
      // Place station near the island interior, away from dock
      const angle = randAngle();
      const distRatio = randRange(0.12, 0.38);
      const pos = getIslandSurfacePoint(island, distRatio, angle, 0.4);
      return {
        id: uuid(),
        type,
        position: pos,
        claimedByShipId: null,
      };
    });
  }
```

- [ ] **Step 4: Add `upgrades` to buildShip**

In `buildShip` (around line 194), add `upgrades: [],` to the returned object after `alive: true`:

```typescript
      alive: true,
      upgrades: [],
```

- [ ] **Step 5: Commit**

```bash
git add src/server/world/MapGenerator.ts
git commit -m "feat: spawn upgrade stations on islands with hull/cannon/speed types"
```

---

## Task 6: Inventory bar + keg cooldown HUD

**Files:**
- Modify: `src/client/core/Game.ts`

This task adds the inventory bar DOM elements and updates `updateHud()`.

- [ ] **Step 1: Find where the HUD HTML is built**

Search for where the main HUD elements are created in `Game.ts`. Look for a method like `buildHud()` or `createHudElements()` that creates DOM nodes. Find the div that holds the HUD and add the inventory bar.

Run:
```bash
grep -n "createElement\|innerHTML\|interactPrompt\|healthFill\|ammoCurrentn\|ammoCurrent" /Users/tobiasdicker/pirates-br/src/client/core/Game.ts | head -40
```

- [ ] **Step 2: Add inventory bar HTML to HUD builder**

Find the HUD initialization method and add an inventory bar container. After finding the section that creates HUD elements, add:

```typescript
// Inventory bar
const inventoryBar = document.createElement('div');
inventoryBar.id = 'inventory-bar';
inventoryBar.style.cssText = `
  position:fixed; bottom:8px; left:50%; transform:translateX(-50%);
  display:flex; gap:6px; align-items:center;
  background:rgba(0,0,0,0.55); backdrop-filter:blur(6px);
  border:1px solid rgba(255,255,255,0.12); border-radius:8px;
  padding:6px 12px; pointer-events:none; z-index:50;
`;
document.body.appendChild(inventoryBar);
this.ui.inventoryBar = inventoryBar;

// Keg display (right side of inventory bar)
const kegDisplay = document.createElement('div');
kegDisplay.id = 'keg-display';
kegDisplay.style.cssText = `
  position:fixed; bottom:8px; right:12px;
  background:rgba(0,0,0,0.55); backdrop-filter:blur(6px);
  border:1px solid rgba(255,255,255,0.12); border-radius:8px;
  padding:6px 10px; pointer-events:none; z-index:50;
  font:bold 13px monospace; color:#e8d8a0; min-width:64px; text-align:center;
`;
document.body.appendChild(kegDisplay);
this.ui.kegDisplay = kegDisplay;
```

Also add `inventoryBar: HTMLDivElement; kegDisplay: HTMLDivElement;` to the `ui` type/object.

- [ ] **Step 3: Add updateInventoryBar helper**

Add this method to `Game`:

```typescript
  private updateInventoryBar() {
    const ship = this.getTrackedShip();
    const player = this.getLocalPlayer();
    if (!this.ui.inventoryBar || !this.ui.kegDisplay || !player) return;

    if (!ship || player.state === 'swimming') {
      this.ui.inventoryBar.style.display = 'none';
      this.ui.kegDisplay.style.display = 'none';
      return;
    }

    this.ui.inventoryBar.style.display = 'flex';
    this.ui.kegDisplay.style.display = 'block';

    const ITEMS: Array<{ item: string; label: string; icon: string }> = [
      { item: 'wood_plank',   label: 'Planks',    icon: '🪵' },
      { item: 'cannonball',   label: 'Balls',     icon: '💣' },
      { item: 'firebomb_ball',label: 'Firebombs', icon: '🔥' },
      { item: 'chainshot',    label: 'Chain',     icon: '⛓' },
      { item: 'banana',       label: 'Bananas',   icon: '🍌' },
    ];

    this.ui.inventoryBar.innerHTML = ITEMS.map(({ item, label, icon }) => {
      const qty = this.getInventoryQty(ship, item as any);
      const low = qty <= 2;
      return `<div style="text-align:center;min-width:40px;">
        <div style="font-size:16px;">${icon}</div>
        <div style="font:bold 11px monospace;color:${low && qty === 0 ? '#ff6b6b' : low ? '#ffb366' : '#e8d8a0'};">${qty}</div>
        <div style="font:9px monospace;color:rgba(255,255,255,0.45);margin-top:1px;">${label}</div>
      </div>`;
    }).join('<div style="width:1px;background:rgba(255,255,255,0.1);align-self:stretch;"></div>');

    // Keg display
    if (player.kegCooldown > 0) {
      this.ui.kegDisplay.innerHTML = `<div style="font-size:14px;">💣</div><div style="font:bold 11px monospace;color:#ff6b6b;">⏱ ${Math.ceil(player.kegCooldown)}s</div>`;
    } else {
      const kegColor = player.kegs > 0 ? '#e8d8a0' : '#666';
      this.ui.kegDisplay.innerHTML = `<div style="font-size:14px;">💣</div><div style="font:bold 11px monospace;color:${kegColor};">${player.kegs} kegs [G]</div>`;
    }
  }
```

- [ ] **Step 4: Call updateInventoryBar in updateScene**

In `updateScene(dt)`, add a call after `this.updateHud()` equivalent — look for the `if (this.hudTimer <= 0)` block and add `this.updateInventoryBar();` inside it.

- [ ] **Step 5: Commit**

```bash
git add src/client/core/Game.ts
git commit -m "feat: add inventory bar HUD and keg cooldown display"
```

---

## Task 7: Repair prompts + upgrade badge HUD

**Files:**
- Modify: `src/client/core/Game.ts`

- [ ] **Step 1: Improve repair prompt**

In `updateHud()`, find the `getLookInteraction` call and the section where `repairSection` is computed (around line 2118). Update `getLookInteraction` (or the prompt logic that uses it) so that when `repairSection` is non-null, the prompt shows:

Find the `getLookInteraction` helper or wherever the `repairSection` prompt is set, and ensure it produces:

```typescript
// In getLookInteraction or wherever repairSection prompt is set:
if (repairSection) {
  const planks = ship ? this.getInventoryQty(ship, 'wood_plank') : 0;
  const sectionName = repairSection.charAt(0).toUpperCase() + repairSection.slice(1);
  const hullPct = ship ? Math.round((ship.hull as any)[repairSection] * 100) : 0;
  if (planks > 0) {
    return {
      prompt: `[X] Repair ${sectionName} (${hullPct}% → use 1 plank)`,
      label: `${planks} planks aboard`,
    };
  } else {
    return {
      prompt: `⚠ ${sectionName} at ${hullPct}% — no planks`,
      label: 'Find wood planks on islands',
    };
  }
}
```

- [ ] **Step 2: Add upgrade badge display**

In `updateHud()`, find where the ship hull info is displayed (around line 2076). After it, add upgrade badge rendering. Find `this.ui.shipsAlive` and after the hull section, add:

```typescript
    // Upgrade badges
    const upgradeBadgeEl = document.getElementById('upgrade-badges');
    if (ship && upgradeBadgeEl) {
      const badgeMap: Record<string, string> = {
        hull_reinforcement: '🛡 Hull',
        charged_cannons: '🔴 Cannons',
        swift_sails: '⚡ Speed',
      };
      upgradeBadgeEl.innerHTML = ship.upgrades.map(u =>
        `<span style="background:rgba(0,0,0,0.5);padding:2px 6px;border-radius:4px;font:bold 11px monospace;color:#e8d8a0;">${badgeMap[u.type] ?? u.type}</span>`
      ).join(' ');
      upgradeBadgeEl.style.display = ship.upgrades.length > 0 ? 'flex' : 'none';
    }
```

Also create the DOM element in the HUD builder:
```typescript
const upgradeBadges = document.createElement('div');
upgradeBadges.id = 'upgrade-badges';
upgradeBadges.style.cssText = `
  position:fixed; top:8px; left:50%; transform:translateX(-50%);
  display:none; gap:4px; align-items:center; z-index:50; pointer-events:none;
`;
document.body.appendChild(upgradeBadges);
```

- [ ] **Step 3: Throttle minimap to 250ms**

In `frame()` / `updateScene()`, find `this.minimapTimer = 0.1;` and change to:
```typescript
      this.minimapTimer = 0.25;
```

- [ ] **Step 4: Commit**

```bash
git add src/client/core/Game.ts
git commit -m "feat: better repair prompts, upgrade badge HUD, minimap throttle 250ms"
```

---

## Task 8: Cannon barrel rotation in ShipRenderer

**Files:**
- Modify: `src/client/rendering/ShipRenderer.ts`

- [ ] **Step 1: Update ShipMeshGroup to store barrel refs**

Find the `ShipMeshGroup` interface (around line 254) and add:
```typescript
  cannonBarrels: THREE.Mesh[];
```

- [ ] **Step 2: Collect barrel refs during buildShip**

In `buildShip`, find where `cannonGroups.push(cg)` is called (around line 778). Before that line, add:

```typescript
        // Store the barrel mesh for aim-based rotation
        cannonBarrels.push(barrel);
```

And declare `cannonBarrels` before the cannon loop (around line 729):
```typescript
    const cannonBarrels: THREE.Mesh[] = [];
```

Update the `shipMeshes.set` call (around line 884) to include `cannonBarrels`:
```typescript
    this.shipMeshes.set(ship.id, {
      root: group,
      sails,
      pennants,
      fireParticles: null,
      damageMeshes: [],
      cannonMeshes: cannonGroups,
      cannonBarrels,
      lanterns,
      wheel: wheelGroup,
      anchor,
      anchorChain,
      wake,
    });
```

- [ ] **Step 3: Update ShipRenderer.update() signature to accept players**

Change the signature from:
```typescript
  update(ships: Ship[], t: number, dt = 1 / 60) {
```
to:
```typescript
  update(ships: Ship[], players: Player[], t: number, dt = 1 / 60) {
```

Add the import at the top of `ShipRenderer.ts`:
```typescript
import type { Ship, Player } from '../../shared/types/index.js';
```

- [ ] **Step 4: Add cannon aim rotation in the update loop**

In `update()`, after the pennant animation block (after the `for (const pennant of mesh.pennants)` loop), add:

```typescript
      // Cannon barrel rotation — track player aim
      const stats = SHIP_STATS[ship.type];
      const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
      for (let ci = 0; ci < mesh.cannonMeshes.length; ci++) {
        const cg = mesh.cannonMeshes[ci];
        const barrel = mesh.cannonBarrels[ci];
        if (!cg || !barrel) continue;

        const side = ci < cannonsPerSide ? 0 : 1;
        const baseGroupY = side === 0 ? 0 : Math.PI;
        const atPlayer = players.find(p =>
          p.onShipId === ship.id && p.atCannon && p.cannonIndex === ci
        );

        if (atPlayer) {
          // Player world yaw → ship-local yaw deviation from broadside
          const localYaw = atPlayer.rotation.x - ship.rotation;
          // cg.rotation.y = localYaw - π/2 maps localYaw=π/2 (starboard) → 0 (default)
          const targetGroupY = localYaw - Math.PI * 0.5;
          cg.rotation.y += angleWrap(targetGroupY - cg.rotation.y) * Math.min(1, dt * 14);
          // Barrel pitch: rotation.z = π/2 - pitch tilts muzzle up when pitch > 0
          barrel.rotation.z += (Math.PI * 0.5 - atPlayer.rotation.y - barrel.rotation.z) * Math.min(1, dt * 14);
        } else {
          // Return to default broadside position
          cg.rotation.y += angleWrap(baseGroupY - cg.rotation.y) * Math.min(1, dt * 5);
          barrel.rotation.z += (Math.PI * 0.5 - barrel.rotation.z) * Math.min(1, dt * 5);
        }
      }
```

- [ ] **Step 5: Update the call site in Game.ts**

In `src/client/core/Game.ts`, find the `this.shipRenderer.update(...)` call (around line 1633):
```typescript
    this.shipRenderer.update(this.state.ships, this.ocean.getTime(), dt);
```
Change to:
```typescript
    this.shipRenderer.update(this.state.ships, this.state.players, this.ocean.getTime(), dt);
```

- [ ] **Step 6: Commit**

```bash
git add src/client/rendering/ShipRenderer.ts src/client/core/Game.ts
git commit -m "feat: cannon barrel rotates to track player aim (SoT-style)"
```

---

## Task 9: Island forge mesh + upgrade pennant flags

**Files:**
- Modify: `src/client/rendering/ShipRenderer.ts`
- Modify: `src/client/core/Game.ts`

- [ ] **Step 1: Add upgrade pennant rendering in ShipRenderer.update()**

In `ShipRenderer.update()`, after the existing pennant animation loop (`for (const pennant of mesh.pennants)`), add upgrade pennant logic. First, in `buildShip()`, after the mast loop (where regular pennants are built), mark each pennant with userData so they can be found. Then add:

After the existing `for (const pennant of mesh.pennants)` animation block, add:

```typescript
      // Upgrade pennants — add colored flags below the main pennant when upgrades are active
      const upgradeColors: Record<string, number> = {
        hull_reinforcement: 0x4488FF,
        charged_cannons: 0xFF3333,
        swift_sails: 0xFFCC00,
      };
      // Lazily add upgrade pennant meshes the first time upgrades are detected
      const existingUpgradePennants = (mesh.root as any).__upgradePennants as Map<string, THREE.Mesh> | undefined;
      if (!existingUpgradePennants) {
        (mesh.root as any).__upgradePennants = new Map<string, THREE.Mesh>();
      }
      const upgradePennants = (mesh.root as any).__upgradePennants as Map<string, THREE.Mesh>;
      const mastH = SHIP_STATS[ship.type].height * 3.1;
      const mastStartZ = SHIP_STATS[ship.type].length * 0.22;

      for (const upgrade of ship.upgrades) {
        if (!upgradePennants.has(upgrade.type)) {
          const color = upgradeColors[upgrade.type] ?? 0xffffff;
          const pennant = new THREE.Mesh(
            new THREE.PlaneGeometry(0.7, 0.18),
            new THREE.MeshStandardMaterial({
              color,
              emissive: color,
              emissiveIntensity: 0.35,
              roughness: 0.7,
              side: THREE.DoubleSide,
            }),
          );
          const slotIndex = upgradePennants.size;
          pennant.position.set(0, SHIP_STATS[ship.type].height + mastH - 0.72 - slotIndex * 0.28, mastStartZ);
          mesh.root.add(pennant);
          upgradePennants.set(upgrade.type, pennant);
        }
      }
      // Animate upgrade pennants same as normal pennants
      const localWind2 = angleWrap(sampleWind(t).direction - ship.rotation);
      for (const [, upPennant] of upgradePennants) {
        upPennant.rotation.y = Math.PI * 0.5 + localWind2;
        upPennant.rotation.z = Math.sin(t * 9 + upPennant.position.z) * 0.14;
      }
```

- [ ] **Step 2: Add forge mesh rendering on islands in Game.ts**

In `Game.ts`, find where island chests are built (the `buildIsland` method or wherever `chestMeshes` are populated, around line 1550-1607). Add forge station rendering after the chest loop:

```typescript
    // Upgrade forge stations
    for (const station of island.upgradeStations) {
      const forgeGroup = new THREE.Group();
      const stationColors: Record<string, number> = {
        hull_reinforcement: 0x4488FF,
        charged_cannons: 0xFF3333,
        swift_sails: 0xFFCC00,
      };
      const color = stationColors[station.type] ?? 0xffffff;

      // Anvil base
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.3, 0.7),
        new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.5, metalness: 0.8 }),
      );
      base.position.y = 0.15;
      base.castShadow = true;
      forgeGroup.add(base);

      // Anvil top
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.12, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.4, metalness: 0.9 }),
      );
      top.position.y = 0.36;
      forgeGroup.add(top);

      // Glowing gem indicating type
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.12, 0),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, roughness: 0.2 }),
      );
      gem.position.y = 0.56;
      forgeGroup.add(gem);

      const glow = new THREE.PointLight(color, 1.4, 6);
      glow.position.y = 0.7;
      forgeGroup.add(glow);

      forgeGroup.position.set(
        station.position.x - island.position.x,
        station.position.y,
        station.position.z - island.position.z,
      );

      const islandGroup = this.environment.getObjectByName(`island_${island.id}`);
      if (islandGroup) {
        islandGroup.add(forgeGroup);
      } else {
        forgeGroup.position.set(station.position.x, station.position.y, station.position.z);
        this.environment.add(forgeGroup);
      }

      // Dim forge when claimed
      this.forgeMeshes.set(station.id, { root: forgeGroup, gem, glow });
    }
```

Also declare `forgeMeshes: Map<string, { root: THREE.Group; gem: THREE.Mesh; glow: THREE.PointLight }> = new Map();` in the `Game` class.

In `updateScene`, add:
```typescript
    // Dim claimed forges
    if (this.state) {
      for (const island of this.state.islands) {
        for (const station of island.upgradeStations) {
          const forgeMesh = this.forgeMeshes.get(station.id);
          if (forgeMesh && station.claimedByShipId) {
            (forgeMesh.gem.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.08;
            forgeMesh.glow.intensity = 0.15;
          }
        }
      }
    }
```

- [ ] **Step 3: Add forge station on minimap**

In `renderBattleMap`, after the island circles are drawn, add:

```typescript
    // Upgrade station markers
    ctx.save();
    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const sx = centerX + station.position.x * scale;
        const sy = centerY + station.position.z * scale;
        const claimed = !!station.claimedByShipId;
        const stationDotColors: Record<string, string> = {
          hull_reinforcement: claimed ? '#3a5588' : '#4488FF',
          charged_cannons: claimed ? '#883333' : '#FF4444',
          swift_sails: claimed ? '#887700' : '#FFCC00',
        };
        ctx.fillStyle = stationDotColors[station.type] ?? '#ffffff';
        ctx.globalAlpha = claimed ? 0.35 : 0.9;
        ctx.beginPath();
        ctx.arc(sx, sy, fullscreen ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
```

- [ ] **Step 4: Commit**

```bash
git add src/client/rendering/ShipRenderer.ts src/client/core/Game.ts
git commit -m "feat: island forge meshes, upgrade pennant flags on ship masts, minimap markers"
```

---

## Task 10: Performance + shadow map + cannon reticle

**Files:**
- Modify: `src/client/rendering/Renderer.ts`
- Modify: `src/client/core/Game.ts`

- [ ] **Step 1: Reduce shadow map from 1024 to 512**

In `src/client/rendering/Renderer.ts`, find where the directional light's shadow map is configured (around line 91-99). Find:
```typescript
    dirLight.shadow.mapSize.set(1024, 1024);
```
Replace with:
```typescript
    dirLight.shadow.mapSize.set(512, 512);
```

- [ ] **Step 2: Add cannon aim reticle**

In `Game.ts`, find where `scopeOverlay` is managed in `updateHud()` (around line 2115). After that block, add a cannon reticle toggle:

```typescript
    const cannonReticleEl = document.getElementById('cannon-reticle');
    if (cannonReticleEl) {
      cannonReticleEl.style.display = player.atCannon ? 'block' : 'none';
    }
```

Create the cannon reticle in the HUD builder:
```typescript
const cannonReticle = document.createElement('div');
cannonReticle.id = 'cannon-reticle';
cannonReticle.style.cssText = `
  position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
  display:none; width:40px; height:40px; pointer-events:none; z-index:60;
`;
cannonReticle.innerHTML = `
  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="12" stroke="rgba(255,220,100,0.85)" stroke-width="1.5"/>
    <circle cx="20" cy="20" r="2" fill="rgba(255,220,100,0.9)"/>
    <line x1="20" y1="2" x2="20" y2="10" stroke="rgba(255,220,100,0.85)" stroke-width="1.5"/>
    <line x1="20" y1="30" x2="20" y2="38" stroke="rgba(255,220,100,0.85)" stroke-width="1.5"/>
    <line x1="2" y1="20" x2="10" y2="20" stroke="rgba(255,220,100,0.85)" stroke-width="1.5"/>
    <line x1="30" y1="20" x2="38" y2="20" stroke="rgba(255,220,100,0.85)" stroke-width="1.5"/>
  </svg>
`;
document.body.appendChild(cannonReticle);
```

- [ ] **Step 3: Commit**

```bash
git add src/client/rendering/Renderer.ts src/client/core/Game.ts
git commit -m "perf: shadow map 512px, add cannon aim reticle"
```

---

## Task 11: Build + verify

- [ ] **Step 1: Install and build**

```bash
cd /Users/tobiasdicker/pirates-br
npm run build 2>&1 | head -60
```
Expected: TypeScript compilation with 0 errors.

- [ ] **Step 2: Fix any TypeScript errors**

Common issues to watch for:
- `kegCooldown` missing from snapshot serialization — check `buildSnapshot()` in `GameServer.ts` and ensure all new Player/Ship fields are included (they usually are if serialized as `JSON.stringify(this.state)`)
- `upgrades` field missing from `buildShip` return type — ensure it was added in Task 5 Step 4
- `Ship` import missing `ShipUpgrade` in `GameServer.ts` — ensure Task 3 Step 6 added the import

- [ ] **Step 3: Run and test**

```bash
npm start
```

Open browser to localhost. Verify:
1. Press X at cannon → exits cannon immediately
2. Press X at helm → exits helm immediately  
3. Space while in cannon → launches player regardless of cooldown
4. Place 2 kegs → 60s cooldown timer appears
5. Walk near damaged hull section → prompt shows section name + plank count
6. Walk to island forge station → [X] prompt appears, ship gets upgrade
7. After getting upgrade → colored pennant appears on ship mast
8. Inventory bar shows ship items at bottom of screen
9. Cannon barrel visually rotates when aiming

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: full polish pass — fixes, upgrades, HUD, cannon rotation, performance"
```

---

## Self-Review

**Spec coverage check:**
- ✅ X key priority fix — Task 3 Step 5
- ✅ Cannon movement like SoT — Task 8
- ✅ Cannon self-launch fix — Task 3 Step 3
- ✅ Second keg 60s cooldown — Task 3 Steps 2,4
- ✅ Repair more intuitive — Task 7 Step 1
- ✅ Lag + rendering — Task 10 Step 1 (shadow map)
- ✅ Inventory bar — Task 6
- ✅ Blunderbuss — already in constants + loot; no code change needed
- ✅ Flintlock → Flintknock — Task 2
- ✅ Island upgrades — Tasks 4,5,9
- ✅ Upgrade visible to enemies — Task 9 (pennant flags + minimap markers)
- ✅ Cannon/hull upgrades — Tasks 4+5

**Type consistency check:**
- `ShipUpgrade` used in `GameServer.applyShipUpgrade` ✓ (imported in Task 3 Step 6)
- `UpgradeStation` used in `MapGenerator.generateUpgradeStations` ✓ (imported in Task 5 Step 1)
- `SHIP_UPGRADES` imported in `GameServer`, `PhysicsSystem`, `WeaponSystem` ✓ (Tasks 3,4)
- `ship.upgrades` field added to `buildShip` ✓ (Task 5 Step 4)
- `player.kegCooldown` added to `createPlayer` ✓ (Task 3 Step 1)
- `cannonBarrels` added to `ShipMeshGroup` and populated ✓ (Task 8)
- `Player` imported in `ShipRenderer.ts` ✓ (Task 8 Step 3)
