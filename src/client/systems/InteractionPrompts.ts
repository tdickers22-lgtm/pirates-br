/**
 * The look-at interaction arbiter: scores every candidate prompt (helm, sails,
 * cannons, ladders, chests, kegs, doors, harvest…), resolves which one the HUD
 * shows, and wires the clickable prompt element.
 */
import * as THREE from 'three';
import { ECONOMY, HARVEST, PLAYER, SHIP_STATS, UPGRADE_COSTS } from '../../shared/constants/index.js';
import type { GameState, Island, IslandNpc, IslandProp, ItemStack, Player, Ship, ShipHole, ShipKeg, ShipUpgradeType, TreasureChest, UpgradeStation } from '../../shared/types/index.js';
import { dist2D, getBraceStationLocals, getIslandDockSwimLadderPoint, getIslandSurfaceY, getMainMastLocalZ, getNearestShipBoardingLadder, getSailRopeStationLocals } from '../../shared/utils/index.js';
import {
  findNearbyCannonIndex,
  getAmmoCrateLocal,
  getAnchorControlLocal,
  getCannonDeckLocalPosition,
  isNearAmmoCrate,
  isNearAnchor,
  isNearCrowNestLadder,
  isNearHelm,
  isNearSailStation,
  toShipLocalPoint,
} from '../../shared/interactions.js';
import type { ClientInteractKind } from '../core/Game.js';
import type { UiRefs } from '../ui/UiRefs.js';

export type InteractionView = {
  readonly ui: UiRefs;
  readonly state: GameState | null;
  readonly barrelBrowse: { barrelId: string; loot: ItemStack[]; lastEventAt: number } | null;
  readonly tavernDoors: Array<{ islandId: string; node: THREE.Object3D; open: boolean }>;
  readonly visibleInteractKind: ClientInteractKind | null;
  lastInteractKind: ClientInteractKind | null;
  mermaidAnchor: { x: number; z: number; shipId: string } | null;
  pendingInteractFromUi: boolean;
  pendingLaunchFromUi: boolean;
  createMermaidAnchor(player: Player, ship: Ship): { x: number; z: number; shipId: string };
  findChestById(chestId: string): TreasureChest | null;
  findHarvestTarget(player: Player): { prop: IslandProp; island: Island } | null;
  findNearbyKeg(player: Player, ship?: Ship | null): ShipKeg | null;
  findRepairableHole(player: Player, ship: Ship): ShipHole | null;
  getBarrelWorldPoint(barrelId: string): THREE.Vector3 | null;
  getChestWorldPoint(chestId: string): THREE.Vector3 | null;
  getInventoryQty(ship: Ship | null, item: ItemStack['item']): number;
  getLocalPlayer(): Player | null;
  getLookDirection(player: Player): THREE.Vector3;
  getMermaidReturnShip(player: Player): Ship | null;
  getNearbyGoldHoarder(player: Player): { npc: IslandNpc; island: Island } | null;
  getNearbyUpgradeStation(player: Player): UpgradeStation | null;
  getRepairPlankCount(player: Player, ship: Ship | null): number;
  getHoleRepairWorldPoint(ship: Ship, hole: ShipHole): THREE.Vector3;
  getShipWorldPoint(ship: Ship, localX: number, localZ: number, worldY: number): THREE.Vector3;
  getTavernDoorWorldPoint(door: { node: THREE.Object3D }, out: THREE.Vector3): THREE.Vector3;
  getTrackedShip(): Ship | null;
  getUpgradePresentation(type: ShipUpgradeType): {
    name: string;
    short: string;
    icon: string;
    color: string;
    hex: number;
    effect: string;
  };
};

export class InteractionPrompts {
  constructor(private readonly view: InteractionView) {}

  resolveCurrentInteractKind(): ClientInteractKind | null {
    if (!this.view.state) return null;
    const player = this.view.getLocalPlayer();
    if (!player) return null;
    const ship = this.view.getTrackedShip();
    const nearbyCannon = ship ? findNearbyCannonIndex(player, ship) : null;
    const repairHole = ship ? this.view.findRepairableHole(player, ship) : null;
    const lookInteraction = this.getLookInteraction(player, ship, nearbyCannon, repairHole);
    // Mid-mast-climb, X means "let go" (server-owned) — don't let a stray
    // chest/door candidate claim the press.
    const canPickInteractKind = !player.atCannon && !player.atHelm && !player.atCrowNest
      && player.mastClimb === null
      && player.state !== 'respawning' && player.state !== 'eliminated';
    return canPickInteractKind && lookInteraction ? lookInteraction.kind : null;
  }


  getLookInteraction(
    player: Player,
    ship: Ship | null,
    nearbyCannon: number | null,
    repairHole: ShipHole | null,
  ): { prompt: string; label: string; kind: ClientInteractKind } | null {
    const candidates: Array<{ prompt: string; label: string; score: number; kind: ClientInteractKind }> = [];
    // A FOUNDERING ship offers no work: every station/repair/board prompt on
    // it is a lie (the server refuses, the crew has splashed out) — pressing
    // a stale "[X] Use Cannon" on a sinking deck read as "X threw me in the
    // water". Drop the ship from candidate generation entirely.
    if (ship?.sinking) {
      ship = null;
      nearbyCannon = null;
      repairHole = null;
    }

    // Downed crewmate nearby → hold to revive (server drains reviveProgress).
    if (this.view.state && player.state === 'alive' && player.shipId) {
      for (const other of this.view.state.players) {
        if (other.id === player.id || other.state !== 'downed') continue;
        if (other.shipId !== player.shipId) continue;
        const d2 = dist2D(player.position.x, player.position.z, other.position.x, other.position.z);
        if (d2 > 3.2 || Math.abs(other.position.y - player.position.y) > 2.2) continue;
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(other.position.x, other.position.y + 0.5, other.position.z),
          3.4,
          0.1,
          `[X] Revive ${other.name}`,
          'Hold to stabilize your crewmate',
          'revive',
        );
      }
    }

    const mermaidShip = this.view.getMermaidReturnShip(player);
    if (mermaidShip) {
      if (!this.view.mermaidAnchor || this.view.mermaidAnchor.shipId !== mermaidShip.id) {
        this.view.mermaidAnchor = this.view.createMermaidAnchor(player, mermaidShip);
      }
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(this.view.mermaidAnchor!.x, player.position.y + 0.65, this.view.mermaidAnchor!.z),
        6.4,
        0.12,
        '[X] Return To Ship',
        'Mermaid ferry waiting nearby',
        'mermaid',
      );
    }

    if (player.nearBarrelId) {
      const barrelPos = this.view.getBarrelWorldPoint(player.nearBarrelId);
      if (barrelPos) {
        const browsingThisBarrel = this.view.barrelBrowse?.barrelId === player.nearBarrelId;
        this.pushInteractionCandidate(
          candidates,
          player,
          barrelPos,
          5.5,
          0.72,
          browsingThisBarrel ? '[X] Take All' : '[X] Look Inside',
          browsingThisBarrel ? 'Transfer supplies' : 'Supply barrel · opening shows what’s inside',
          'barrel',
        );
      }
    }

    const nearbyGoldHoarder = this.view.getNearbyGoldHoarder(player);
    if (nearbyGoldHoarder) {
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(nearbyGoldHoarder.npc.position.x, nearbyGoldHoarder.npc.position.y + 1.05, nearbyGoldHoarder.npc.position.z),
        4.6,
        0.2,
        player.carryingChestId
          ? '[X] Sell Chest'
          : (player.treasureMapIslandId && player.gold >= ECONOMY.ARMOR_PRICE && (player.armor ?? 0) < PLAYER.MAX_ARMOR * 0.5)
            ? `[X] Buy Iron Cuirass (${ECONOMY.ARMOR_PRICE}g)`
            : '[X] Get Treasure Map',
        player.carryingChestId
          ? `Gold Hoarder pays toward ${ECONOMY.GOLD_WIN_TARGET}`
          : (player.treasureMapIslandId && player.gold >= ECONOMY.ARMOR_PRICE && (player.armor ?? 0) < PLAYER.MAX_ARMOR * 0.5)
            ? `Combat plate — absorbs ${PLAYER.MAX_ARMOR} damage, lost on death`
            : 'Gold Hoarder chart marks buried treasure',
        'gold_hoarder',
      );
    }

    if (player.nearChestId && !player.carryingChestId) {
      const chestPos = this.view.getChestWorldPoint(player.nearChestId);
      const chest = this.view.findChestById(player.nearChestId);
      if (chestPos && chest && chest.carriedByPlayerId !== player.id) {
        const digging = chest.buried && chest.digProgress < 1;
        const prompt = digging
          ? (player.hasShovel ? '[Hold X] Dig' : 'Find a shovel')
          : chest.carriedByPlayerId
            ? '[X] Steal Chest'
            : chest.storedOnShipId
              ? '[X] Take Chest'
              : chest.floating
                ? '[X] Grab Floating Chest'
                : '[X] Pick Up Chest';
        const label = digging
          ? `Buried treasure · ${Math.round(chest.digProgress * 100)}% dug`
          : `Base ${chest.value} gold · Gold Hoarder pays more`;
        this.pushInteractionCandidate(candidates, player, chestPos, 5.5, 0.72, prompt, label, 'chest');
      }
    }

    if (!player.onShipId && player.nearShipId && this.view.state) {
      const targetShip = this.view.state.ships.find((candidate) => candidate.id === player.nearShipId && candidate.alive);
      if (targetShip) {
        const ladder = getNearestShipBoardingLadder(targetShip, player.position);
        // Mirror the server's acceptance (PhysicsSystem nearShipId gate):
        // swimmers board within 3.5m of the LADDER point, islanders within
        // 3.0m. The old deck-height candidate showed [X] in spots where
        // tryBoardFromLadder refused — pressing did nothing.
        const maxLadderDist = player.state === 'swimming' ? 3.5 : 3.0;
        if (ladder && ladder.distance <= maxLadderDist) {
          const boardPoint = new THREE.Vector3(ladder.x, targetShip.position.y + SHIP_STATS[targetShip.type].height * 0.4, ladder.z);
          this.pushInteractionCandidate(candidates, player, boardPoint, 7.0, 0.35, '[X] Climb Ladder', 'Board from the side ladder', 'board');
        }
      }
    }

    // Axe harvest — CLIENT-ONLY prompt ('harvest' never rides interactIntent);
    // holding LMB swings the axe and the server does the felling via useItem.
    if (player.equippedTool === 'axe' && player.state === 'alive' && this.view.state) {
      const harvestTarget = this.view.findHarvestTarget(player);
      if (harvestTarget) {
        const { prop: bestProp, island: bestIsland } = harvestTarget;
        const isPalm = bestProp.type.startsWith('palm_');
        const propY = getIslandSurfaceY(bestIsland, bestProp.x, bestProp.z);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(bestProp.x, propY + (isPalm ? 1.6 : 0.7), bestProp.z),
          HARVEST.RANGE + 1.6,
          0.2,
          isPalm ? '[Hold LMB] Chop Palm — wood' : '[Hold LMB] Crack Boulder — ore',
          isPalm
            ? `Fells in ~${HARVEST.CHOP_TIME}s · ${HARVEST.WOOD_PER_TREE_MIN}–${HARVEST.WOOD_PER_TREE_MAX} wood`
            : `Cracks in ~${HARVEST.MINE_TIME}s · ${HARVEST.ORE_PER_BOULDER_MIN}–${HARVEST.ORE_PER_BOULDER_MAX} ore`,
          'harvest',
        );
      }
    }

    if (player.state === 'swimming' && this.view.state) {
      for (const isl of this.view.state.islands) {
        if (!isl.dock) continue;
        const dock = isl.dock;
        const dx = player.position.x - dock.position.x;
        const dz = player.position.z - dock.position.z;
        const cos = Math.cos(dock.rotation);
        const sin = Math.sin(dock.rotation);
        // Canonical dock frame (shared toDockLocalPoint / Match.tryClimb…):
        // +local-z is SEAWARD, so the swim-up band is a POSITIVE z window.
        // The old mirrored frame put the prompt on the landward side, where
        // the server would never grant the climb.
        const localX = dx * cos - dz * sin;
        const localZ = dx * sin + dz * cos;
        if (Math.abs(localX) > dock.width * 0.42) continue;
        if (localZ < dock.length * 0.08 || localZ > dock.length * 0.58) continue;
        const ladderPoint = getIslandDockSwimLadderPoint(dock);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(ladderPoint.x, ladderPoint.y, ladderPoint.z),
          4.2,
          0.45,
          '[X] Climb Dock Ladder',
          'Swim up to the wooden dock',
          'dock',
        );
      }
    }

    const nearbyKeg = this.view.findNearbyKeg(player, ship ?? null);
    if (nearbyKeg) {
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(nearbyKeg.position.x, nearbyKeg.position.y + 0.45, nearbyKeg.position.z),
        3,
        0.3,
        '[X] Defuse Powder Keg',
        `${Math.max(1, Math.ceil(nearbyKeg.timer))}s until detonation`,
        'keg_diffuse',
      );
    }

    if (ship) {
      // Bail the bilge — physical bucket work. Only offered with the BUCKET tool
      // equipped from the supply wheel; otherwise a hint nudges you to equip it.
      // Low priority so cannons/helm/repairs win when you're facing one.
      const flooded = (ship.waterLevel ?? 0) > 0.02;
      const hasBucket = player.equippedTool === 'bucket';
      if (player.onShipId === ship.id && (flooded || (hasBucket && player.bucketFilled))) {
        const pct = Math.round((ship.waterLevel ?? 0) * 100);
        let prompt: string;
        let label: string;
        if (!hasBucket) {
          prompt = 'Equip the Bucket [Hold I] to bail';
          label = `Bilge flooding ${pct}% · grab the bucket from the supply wheel`;
        } else if (player.bucketFilled) {
          prompt = '[X] Heave the water overboard';
          label = 'Bucket full — toss it over the side';
        } else {
          prompt = '[X] Fill the bucket from the bilge';
          label = `Bilge flooding ${pct}% · scoop a bucketful out`;
        }
        candidates.push({ prompt, label, score: -0.5, kind: 'bail' });
      }

      if (player.carryingChestId && player.onShipId === ship.id) {
        const stats = SHIP_STATS[ship.type];
        const stowPoint = this.view.getShipWorldPoint(ship, 0, -stats.length * 0.22, stats.height + 0.7);
        this.pushInteractionCandidate(
          candidates,
          player,
          stowPoint,
          4.8,
          0.16,
          '[X] Stow Chest',
          'Place chest on deck for the crew',
          'stow_chest',
        );
      }

      const nearbyStation = this.view.getNearbyUpgradeStation(player);
      if (
        nearbyStation
        && nearbyStation.claimedByShipId !== ship.id
        && !ship.upgrades.some((upgrade) => upgrade.type === nearbyStation.type)
      ) {
        const meta = this.view.getUpgradePresentation(nearbyStation.type);
        // Materials honesty: show the recipe and whether the crew can pay it
        // (pocket + ship hold combined — the server drains the same pool).
        const cost = UPGRADE_COSTS[nearbyStation.type];
        const woodHave = player.pocketWood + this.view.getInventoryQty(ship, 'wood_plank');
        const oreHave = (player.pocketOre ?? 0) + this.view.getInventoryQty(ship, 'ore');
        const needs: string[] = [];
        if (woodHave < cost.wood) needs.push(`Need ${cost.wood - woodHave} more wood`);
        if (oreHave < cost.ore) needs.push(`Need ${cost.ore - oreHave} more ore`);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(nearbyStation.position.x, nearbyStation.position.y + 0.9, nearbyStation.position.z),
          4.4,
          0.2,
          `[X] Claim ${meta.name} — ${cost.wood} wood · ${cost.ore} ore`,
          `${needs.length > 0 ? needs.join(' · ') : 'Materials ready'} · ${meta.effect}`,
          'upgrade',
        );
      }

      if (isNearHelm(player, ship)) {
        const helmPoint = this.view.getShipWorldPoint(ship, 0, -SHIP_STATS[ship.type].length * 0.37, SHIP_STATS[ship.type].height + 0.95);
        this.pushInteractionCandidate(candidates, player, helmPoint, 4.2, 0.2, '[X] Take Helm', 'A/D or arrows turn · W/S trims sails', 'helm');
      }

      if (isNearSailStation(player, ship)) {
        const ropeStations = getSailRopeStationLocals(SHIP_STATS[ship.type]);
        const localHere = toShipLocalPoint(player.position, ship);
        const sailControl = ropeStations.reduce((best, st) =>
          Math.hypot(localHere.x - st.x, localHere.z - st.z) < Math.hypot(localHere.x - best.x, localHere.z - best.z) ? st : best);
        const sailPoint = this.view.getShipWorldPoint(ship, sailControl.x, sailControl.z, SHIP_STATS[ship.type].height + 0.85);
        const sailPct = Math.round(ship.sailHeight * 100);
        const canvasTorn = ship.sailIntegrity < 0.995;
        const sailPrompt = canvasTorn
          ? `[X] Hold — Mend the Rigging (${Math.round(ship.sailIntegrity * 100)}%)`
          : ship.sailHeight < 0.5
            ? `[X] Hold — Drop the Sails (${sailPct}%)`
            : `[X] Hold — Raise the Sails (${sailPct}%)`;
        this.pushInteractionCandidate(
          candidates,
          player,
          sailPoint,
          4.2,
          0.08,
          sailPrompt,
          canvasTorn ? 'Needs planks aboard · crewmates on the rope haul faster' : 'Crewmates on the rope haul faster',
          'sails',
        );
      }

      if (player.onShipId === ship.id && ship.sailIntegrity >= 0.995) {
        // Brace rails — the physical station that ANGLES the yard. One
        // candidate per side; the arbiter picks whichever you're looking at.
        const stats = SHIP_STATS[ship.type];
        const trimDeg = Math.round((ship.sailAngle * 180) / Math.PI);
        for (const brace of getBraceStationLocals(stats)) {
          const bracePoint = this.view.getShipWorldPoint(ship, brace.x, brace.z, stats.height + 0.7);
          this.pushInteractionCandidate(
            candidates,
            player,
            bracePoint,
            4.0,
            0.1,
            `[X] Hold — Brace the Yard to ${brace.dir > 0 ? 'Starboard' : 'Port'} (${trimDeg > 0 ? '+' : ''}${trimDeg}°)`,
            'Angle the sails to catch the wind',
            'brace',
          );
        }
      }

      if (isNearCrowNestLadder(player, ship)) {
        const stats = SHIP_STATS[ship.type];
        const mastZ = getMainMastLocalZ(stats);
        const ladderPoint = this.view.getShipWorldPoint(ship, 0, mastZ, stats.height + 1.15);
        this.pushInteractionCandidate(
          candidates,
          player,
          ladderPoint,
          3.2,
          0.24,
          '[X] Climb the Mast',
          'Main mast ladder · W/S climbs to the crow\'s nest',
          'crow',
        );
      }

      if (isNearAnchor(player, ship)) {
        const anchorLocal = getAnchorControlLocal(SHIP_STATS[ship.type]);
        const anchorPoint = this.view.getShipWorldPoint(ship, anchorLocal.x, anchorLocal.z, SHIP_STATS[ship.type].height + 0.45);
        const anchorProgress = Math.round((ship.anchorRaiseProgress ?? 0) * 100);
        this.pushInteractionCandidate(
          candidates,
          player,
          anchorPoint,
          4.4,
          0.18,
          ship.anchored ? `[X] Hold — Raise the Anchor (${anchorProgress}%)` : '[X] Drop the Anchor',
          ship.anchored ? 'Man the capstan · crewmates speed the turn' : 'Stops the ship fast — you will have to crank it back up',
          'anchor',
        );
      }

      // ONE breach, the one under your boots — not a whole quarter of the hull.
      if (repairHole) {
        const repairPoint = this.view.getHoleRepairWorldPoint(ship, repairHole);
        const plankCount = this.view.getRepairPlankCount(player, ship);
        this.pushInteractionCandidate(
          candidates,
          player,
          repairPoint,
          4.5,
          0.52,
          plankCount > 0 ? '[X] Hold — Plank This Leak' : '⚠ Leak here',
          plankCount > 0
            ? `${plankCount} plank${plankCount === 1 ? '' : 's'} ready`
            : 'No planks ready',
          'repair',
        );
      }

      if (nearbyCannon !== null) {
        const cannonLocal = getCannonDeckLocalPosition(SHIP_STATS[ship.type], nearbyCannon);
        const cannonPoint = this.view.getShipWorldPoint(
          ship,
          cannonLocal.x,
          cannonLocal.z,
          SHIP_STATS[ship.type].height + 0.75,
        );
        this.pushInteractionCandidate(
          candidates,
          player,
          cannonPoint,
          4.8,
          0.16,
          '[X] Use Cannon',
          `Broadside cannon ${nearbyCannon + 1} · [5/6/7] ammo`,
          'cannon',
        );
      }

      // Ammo chest (SoT): aft of the companionway — instant firearm top-up.
      if (player.onShipId === ship.id && isNearAmmoCrate(player, ship)) {
        const crateLocal = getAmmoCrateLocal(SHIP_STATS[ship.type]);
        const cratePoint = this.view.getShipWorldPoint(ship, crateLocal.x, crateLocal.z, SHIP_STATS[ship.type].height + 0.5);
        this.pushInteractionCandidate(
          candidates,
          player,
          cratePoint,
          3.6,
          0.2,
          '[X] Ammo Chest — Refill Firearms',
          'Tops up every gun and clears reloads',
          'ammo',
        );
      }
    }

    // Tavern doors — a client-local toggle; the candidate rides the same
    // arbiter so its prompt can never stack with another [X] prompt.
    if (this.view.tavernDoors.length > 0) {
      const doorPoint = new THREE.Vector3();
      for (const door of this.view.tavernDoors) {
        if (!door.node.parent) continue;
        this.view.getTavernDoorWorldPoint(door, doorPoint);
        this.pushInteractionCandidate(
          candidates,
          player,
          doorPoint,
          3.4,
          0.2,
          `[X] ${door.open ? 'Close' : 'Open'} Door`,
          'Tavern',
          'door',
        );
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ?? null;
  }

  pushInteractionCandidate(
    candidates: Array<{ prompt: string; label: string; score: number; kind: ClientInteractKind }>,
    player: Player,
    point: THREE.Vector3,
    maxDistance: number,
    minDot: number,
    prompt: string,
    label: string,
    kind: ClientInteractKind,
  ) {
    const eyePos = new THREE.Vector3(player.position.x, player.position.y + PLAYER.HEIGHT * 0.72, player.position.z);
    const toPoint = point.clone().sub(eyePos);
    const distance = toPoint.length();
    if (distance > maxDistance) return;

    const lookDir = this.view.getLookDirection(player);
    const dot = toPoint.normalize().dot(lookDir);
    if (dot < minDot) return;

    candidates.push({ prompt, label, score: dot - distance * 0.035, kind });
  }

  bindInteractPromptClick() {
    const el = this.view.ui.interactPrompt;
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.view.lastInteractKind = this.resolveCurrentInteractKind() ?? this.view.visibleInteractKind;
      this.view.pendingInteractFromUi = true;
      const t = el.textContent ?? '';
      if (t.includes('Launch')) {
        this.view.pendingLaunchFromUi = true;
      }
    });
  }
}
