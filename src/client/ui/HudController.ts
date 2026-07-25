/**
 * Owns the in-match HUD: vitals, compass, storm banner, ship/keg/inventory
 * panels, weapon + combat readouts and the kill/event feed. Reads game state
 * through a narrow `HudView` handed in by Game; it never touches the scene.
 */
import * as THREE from 'three';
import { ECONOMY, PLAYER, SHIP, SHIP_STATS, SHIP_UPGRADES, STORM_PHASES, WEAPONS } from '../../shared/constants/index.js';
import type { GameState, Island, IslandNpc, ItemStack, Player, Ship, ShipUpgradeType, WeaponInstance } from '../../shared/types/index.js';
import { angleWrap, isPointInsideIslandFootprint, sampleWind } from '../../shared/utils/index.js';
import type { ClientInteractKind, FloatingDamageIndicator } from '../core/Game.js';
import type { InputManager } from '../input/InputManager.js';
import type { OceanRenderer } from '../rendering/OceanRenderer.js';
import type { Renderer } from '../rendering/Renderer.js';
import type { UiRefs } from './UiRefs.js';

/** Everything the HUD reads or writes on the Game instance. */
export type HudView = {
  readonly ui: UiRefs;
  readonly input: InputManager;
  readonly renderer: Renderer;
  readonly ocean: OceanRenderer;
  readonly shipsById: Map<string, Ship>;
  readonly floatingDamageIndicators: FloatingDamageIndicator[];
  readonly tempHudVector: THREE.Vector3;
  readonly state: GameState | null;
  readonly localPlayerId: string | null;
  readonly spyglassActive: boolean;
  readonly wheelHoverSlot: number | null;
  readonly islandBannerHideAt: number;
  barrelBrowse: { barrelId: string; loot: ItemStack[]; lastEventAt: number } | null;
  hitMarkerTimer: number;
  hitMarkerShip: boolean;
  hitMarkerShark: boolean;
  hitMarkerHeadshot: boolean;
  hitMarkerKill: boolean;
  prevIsInsideIsland: string | null;
  visibleInteractKind: ClientInteractKind | null;
  distance2D(ax: number, az: number, bx: number, bz: number): number;
  findNearbyCannonIndex(player: Player, ship: Ship): number | null;
  findRepairableHullSection(player: Player, ship: Ship): keyof Ship['hull'] | null;
  flashIslandBanner(name: string): void;
  formatCompassHeading(angle: number): string;
  formatStormTimer(seconds: number): string;
  getBlunderbussCrosshairSize(player: Player): number;
  getClosestGoldHoarder(player: Player): { npc: IslandNpc; island: Island; distance: number } | null;
  getInventoryQty(ship: Ship | null, item: ItemStack['item']): number;
  getLocalPlayer(): Player | null;
  getLookInteraction(
    player: Player,
    ship: Ship | null,
    nearbyCannon: number | null,
    repairSection: keyof Ship['hull'] | null,
  ): { prompt: string; label: string; kind: ClientInteractKind } | null;
  getPocketWheelCount(player: Player, slot: number): number;
  getStormTimerSeconds(): number;
  getTrackedShip(): Ship | null;
  getUpgradePresentation(type: ShipUpgradeType): {
    name: string;
    short: string;
    icon: string;
    color: string;
    hex: number;
    effect: string;
  };
  playIslandArrivalFanfare(): void;
  renderMapWheel(player: Player): void;
  renderTreasureInventoryChart(
    player: Player,
    mappedIsland: Island | null,
    closestHoarder: { npc: IslandNpc; island: Island; distance: number } | null,
  ): void;
  returnToLobbyAfterLoss(kills: number, gold: number, reason?: string): void;
  toolWheelSlot(tool: Player['equippedTool']): number;
};

export class HudController {
  constructor(private readonly view: HudView) {}

  private pocketStripSignature = '';
  private shipUpgradeSignature = '';
  private shipInventorySignature = '';
  private brProgressSignature = '';

  private updateBarrelPanel(player: Player, ship: Ship | null) {
    // Close the panel as soon as the player walks away from the barrel they were
    // browsing, or after a brief grace period if no event has refreshed it.
    if (this.view.barrelBrowse && player.nearBarrelId !== this.view.barrelBrowse.barrelId) {
      this.view.barrelBrowse = null;
    }
    if (this.view.barrelBrowse && performance.now() - this.view.barrelBrowse.lastEventAt > 12000) {
      this.view.barrelBrowse = null;
    }

    if (!this.view.barrelBrowse) {
      this.view.ui.barrelPanel.style.display = 'none';
      return;
    }

    this.view.ui.barrelPanel.style.display = 'block';

    const niceName = (item: string) => item.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const renderRows = (target: HTMLElement, rows: ItemStack[], emptyMsg: string) => {
      if (rows.length === 0) {
        target.innerHTML = `<div class="bp-empty">${emptyMsg}</div>`;
        return;
      }
      target.innerHTML = rows
        .map((r) => `<div class="bp-row"><span>${niceName(r.item)}</span><span class="bp-qty">×${r.qty}</span></div>`)
        .join('');
    };

    renderRows(this.view.ui.barrelPanelLoot, this.view.barrelBrowse.loot, '(empty)');

    // Player + ship inventory snapshot (combine pocket + ship inventory)
    const pocket: ItemStack[] = [];
    if (player.pocketBanana) pocket.push({ item: 'banana', qty: player.pocketBanana });
    if (player.pocketCoconut) pocket.push({ item: 'coconut', qty: player.pocketCoconut });
    if (player.pocketMango) pocket.push({ item: 'mango', qty: player.pocketMango });
    if (player.pocketMeat) pocket.push({ item: 'meat', qty: player.pocketMeat });
    if (player.pocketWood) pocket.push({ item: 'wood_plank', qty: player.pocketWood });
    const shipRows = ship ? ship.inventory.filter((s) => s.qty > 0) : [];
    const combined: ItemStack[] = [...pocket];
    for (const row of shipRows) {
      const existing = combined.find((c) => c.item === row.item);
      if (existing) existing.qty += row.qty;
      else combined.push({ ...row });
    }
    renderRows(this.view.ui.barrelPanelInventory, combined, ship ? '(empty hold)' : '(no ship — picks up to pockets)');
  }

  updateHud() {
    if (!this.view.state) return;

    const player = this.view.getLocalPlayer();
    const ship = this.view.getTrackedShip();
    if (!player) return;

    this.updateBarrelPanel(player, ship);

    const timerSeconds = this.view.getStormTimerSeconds();
    const lastPhase = this.view.state.storm.phase >= STORM_PHASES.length - 1;
    const finalHold = lastPhase && !this.view.state.storm.shrinking && timerSeconds <= 0;
    const stormVerb = this.view.state.storm.shrinking ? 'CLOSING' : 'NEXT SHRINK';
    this.view.ui.stormPhase.textContent = finalHold
      ? 'FINAL STORM - NO SAFE HARBOR'
      : `STORM PHASE ${Math.min(this.view.state.storm.phase + 1, STORM_PHASES.length)} - ${stormVerb}`;
    this.view.ui.stormTimer.textContent = finalHold ? '' : this.view.formatStormTimer(timerSeconds);
    this.view.ui.mapSubtitle.textContent = finalHold
      ? 'The storm has fully closed — finish the fight'
      : this.view.state.storm.shrinking
        ? `Storm moving now · closes in ${timerSeconds}s`
        : `Next storm shift in ${timerSeconds}s`;

    const outsideStorm = this.view.distance2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ) > this.view.state.storm.safeRadius;
    const avgHull = ship
      ? (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4
      : 1;
    const shipCritical = !!ship && (ship.sinking || avgHull < 0.2);
    const shipOnFire = !!ship && ship.onFire && !ship.sinking;
    // DOWNED lives on its OWN banner so a fire/storm/critical warning can
    // show at the same time — the old shared element silently swallowed one.
    const localDowned = player.state === 'downed';
    this.view.ui.downedBanner.style.display = localDowned ? 'block' : 'none';
    if (localDowned) {
      const bleed = Math.max(0, Math.ceil(player.downedUntil ?? 0));
      this.view.ui.downedBanner.textContent = (player.reviveProgress ?? 0) > 0
        ? `CREWMATE REVIVING YOU — ${Math.round((player.reviveProgress ?? 0) * 100)}%`
        : `DOWNED — BLEEDING OUT 0:${String(bleed).padStart(2, '0')} · CRAWL TO YOUR CREW`;
      this.view.ui.downedBanner.style.color = (player.reviveProgress ?? 0) > 0 ? '#7ce38b' : '#ff6b6b';
    }
    this.view.ui.stormWarning.style.display = outsideStorm || shipCritical || shipOnFire ? 'block' : 'none';
    this.view.ui.stormWarning.textContent = shipCritical
      ? (ship?.sinking ? 'SHIP IS SINKING' : 'SHIP CRITICAL - REPAIR NOW')
      : shipOnFire
        ? 'FIRE ABOARD - REPAIR TO DOUSE IT'
        : 'OUTSIDE STORM ZONE';
    this.view.ui.stormWarning.style.color = shipCritical || shipOnFire ? '#ffb366' : '#ff6b6b';

    this.view.ui.shipsAlive.textContent = String(this.view.state.shipsAlive);
    this.view.ui.goldAmount.textContent = `${player.gold}/${ECONOMY.GOLD_WIN_TARGET}`;
    this.renderGoldLeaderboard(player.id);
    this.view.ui.killCount.textContent = String(player.kills);
    this.view.ui.healthFill.style.width = `${Math.max(0, player.health)}%`;
    this.view.ui.armorFill.style.width = `${Math.max(0, Math.min(100, ((player.armor ?? 0) / PLAYER.MAX_ARMOR) * 100))}%`;

    if (ship) {
      this.setHull(this.view.ui.hullBow, this.view.ui.hullBowTxt, ship.hull.bow);
      this.setHull(this.view.ui.hullStern, this.view.ui.hullSternTxt, ship.hull.stern);
      this.setHull(this.view.ui.hullPort, this.view.ui.hullPortTxt, ship.hull.port);
      this.setHull(this.view.ui.hullStarboard, this.view.ui.hullStarboardTxt, ship.hull.starboard);
      const wind = sampleWind(this.view.ocean.getTime());
      const signedRelative = angleWrap(wind.direction - ship.rotation);
      // 0.92 matches PhysicsSystem's desired-trim constant + the sail-cloth luff
      // visual, so the displayed Catch% peaks exactly where the ship is fastest.
      const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
      const trimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
      const trimDelta = angleWrap(desiredTrim - ship.sailAngle);
      const trimSide = ship.sailAngle < -0.06 ? 'Port' : ship.sailAngle > 0.06 ? 'Starboard' : 'Centered';
      const windSide = signedRelative < -0.22 ? 'from port' : signedRelative > 0.22 ? 'from starboard' : Math.cos(signedRelative) >= 0 ? 'dead ahead' : 'from astern';
      const windHeading = this.view.formatCompassHeading(wind.direction);
      const windArrow = signedRelative < -0.22 ? '<-' : signedRelative > 0.22 ? '->' : Math.cos(signedRelative) >= 0 ? '^' : 'v';
      const windDegrees = Math.round(Math.abs(THREE.MathUtils.radToDeg(signedRelative)));
      const trimHint = Math.abs(trimDelta) < 0.08
        ? 'Trim set'
        : trimDelta > 0
          ? 'Trim Right [F]'
          : 'Trim Left [Q]';
      const rig =
        ship.sailIntegrity < 0.99
          ? ` · Rigging ${Math.round(ship.sailIntegrity * 100)}% (hold [X] at sails + planks)`
          : '';
      const windLine = `Wind ${windHeading} ${windArrow} ${windDegrees}deg ${windSide}`;
      this.view.ui.sailStatus.textContent = ship.anchored
        ? `Anchored · Hold [X] raise · ${windLine}`
        : `Sails ${Math.round(ship.sailHeight * 100)}%${rig} · Trim ${trimSide} · Catch ${Math.round(trimCatch * 100)}% · ${trimHint} · ${windLine}`;
    } else {
      this.view.ui.sailStatus.textContent = 'No tracked ship';
    }
    this.renderShipUpgrades(ship);
    this.renderShipInventory(ship, player);
    this.renderKegStatus(player);
    this.updateWaterGauge(player);

    let chestsInHold = 0;
    if (ship) {
      for (const isl of this.view.state.islands) {
        for (const ch of isl.chests) {
          if (ch.storedOnShipId === ship.id && !ch.opened) chestsInHold += 1;
        }
      }
    }
    const mappedIsland = player.treasureMapIslandId
      ? this.view.state.islands.find((island) => island.id === player.treasureMapIslandId) ?? null
      : null;
    const closestHoarder = this.view.getClosestGoldHoarder(player);
    const powerLine = this.getSpecialSummary(player);
    const objectiveLine = this.getObjectiveSummary(player, ship, {
      chestsInHold,
      mappedIsland,
      closestHoarder,
      outsideStorm,
      shipCritical,
      shipOnFire,
    });
    const progLine = ship
      ? `${objectiveLine} · ${powerLine} · Gold ${player.gold}/${ECONOMY.GOLD_WIN_TARGET} · Hold ${chestsInHold} · Upgrades ${ship.upgrades.length}`
      : `${objectiveLine} · ${powerLine}`;
    if (progLine !== this.brProgressSignature) {
      this.view.ui.brProgressFeed.textContent = progLine;
      this.brProgressSignature = progLine;
    }

    const pk = player;
    // The 1–4 digit labels are MODAL (they select pocket items only while the
    // wheel is held; otherwise 1–4 are weapon slots, labeled bottom-right).
    // Only advertise the numbers while they actually do that, or the two
    // always-on strips claim the same keys mean two things at once.
    const wheelHeld = this.view.input.isSupplyWheelOpen();
    const stripParts = [
      `Pocket: ${wheelHeld ? '1 ' : ''}Banana ${pk.pocketBanana}`,
      `${wheelHeld ? '2 ' : ''}Plank ${pk.pocketWood}`,
      `Ore ${pk.pocketOre ?? 0}`,
      `${wheelHeld ? '3 ' : ''}Coconut ${pk.pocketCoconut}`,
      `${wheelHeld ? '4 ' : ''}Meat ${pk.pocketMeat} / Mango ${pk.pocketMango}`,
      `Tool: ${pk.hasShovel ? 'Shovel' : 'None'}`,
    ];
    if (mappedIsland) stripParts.push(`Chart: ${mappedIsland.name}`);
    if (closestHoarder && (mappedIsland || pk.carryingChestId)) stripParts.push(`Gold Hoarder: ${closestHoarder.island.name}`);
    if (pk.playerKillStreak > 0) stripParts.push(`Streak ${pk.playerKillStreak}`);
    const specialSummary = this.getSpecialSummary(pk);
    if (specialSummary) stripParts.push(specialSummary);
    const pocketText = stripParts.join(' | ');
    if (pocketText !== this.pocketStripSignature) {
      this.view.ui.pocketStrip.textContent = pocketText;
      this.pocketStripSignature = pocketText;
    }
    this.view.renderTreasureInventoryChart(player, mappedIsland, closestHoarder);
    this.view.ui.pocketWheelStats.textContent = this.view.input.isSupplyWheelOpen()
      ? (player.equippedTool
          ? `Equipped: ${player.equippedTool.toUpperCase()} · ${player.equippedTool === 'spyglass' ? 'aim (right-click) to zoom · draw a weapon to stow' : 'right-click or re-select to stow'} · tools = scope/compass/bucket/shovel/axe · fruit heals · planks → ship stores`
          : 'Tools: scope · compass · bucket (bail) · shovel · lantern · axe (chop/mine) — select to equip · fruit heals · planks → ship stores')
      : '';
    this.updateSupplyWheelCounts(player);
    // [Q] while the wheel is held flips between the SUPPLY page and the QUEST
    // MAPS page (SoT radial) — only one occupies the screen center at a time.
    const wheelOpen = this.view.input.isSupplyWheelOpen();
    const mapsPage = wheelOpen && this.view.input.getWheelPage() === 'maps';
    this.view.ui.pocketWheel.classList.toggle('visible', wheelOpen && !mapsPage);
    this.view.ui.mapWheel.classList.toggle('visible', mapsPage);
    if (mapsPage) this.view.renderMapWheel(player);
    // The controls legend and the supply wheel park on the same screen center
    // — holding [I] closes the legend rather than stacking on top of it.
    if (wheelOpen) {
      const legend = document.getElementById('controls-hint');
      if (legend && legend.style.display === 'block') legend.style.display = 'none';
    }

    let insideIslandId: string | null = null;
    for (const isl of this.view.state.islands) {
      if (isPointInsideIslandFootprint(isl, player.position.x, player.position.z, 6)) {
        insideIslandId = isl.id;
        break;
      }
    }
    if (insideIslandId && insideIslandId !== this.view.prevIsInsideIsland) {
      const isl = this.view.state.islands.find((i) => i.id === insideIslandId);
      if (isl) {
        this.view.flashIslandBanner(isl.name);
        this.view.playIslandArrivalFanfare();
      }
    }
    this.view.prevIsInsideIsland = insideIslandId;
    if (performance.now() > this.view.islandBannerHideAt) {
      this.view.ui.islandBanner.classList.remove('visible');
    }

    const weapon = player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    if (player.atCannon && ship) {
      const cb = this.view.getInventoryQty(ship, 'cannonball');
      this.view.ui.ammoCurrent.textContent =
        player.selectedCannonAmmo === 'cannonball'
          ? String(cb)
          : String(
              player.selectedCannonAmmo === 'firebomb'
                ? this.view.getInventoryQty(ship, 'firebomb_ball')
                : this.view.getInventoryQty(ship, 'chainshot'),
            );
      this.view.ui.ammoReserve.textContent =
        player.selectedCannonAmmo === 'cannonball'
          ? 'ship store (each shot spends 1)'
          : player.selectedCannonAmmo.replace('_', ' ');
      this.view.ui.reloadIndicator.style.display = ship.cannonCooldowns[player.cannonIndex] > 0 ? 'block' : 'none';
    } else {
      this.updateWeaponHud(player.activeSlot, weapon, player.weapons);
      const weaponDef = weapon ? WEAPONS[weapon.weaponId] : null;
      this.view.ui.reloadIndicator.style.display = weapon?.reloading && weaponDef && !weaponDef.melee ? 'block' : 'none';
    }
    const scopeShowing = !!(this.view.spyglassActive
      || (this.view.input.isAiming() && weapon && WEAPONS[weapon.weaponId].scopeFov));
    this.view.ui.scopeOverlay.style.display = scopeShowing ? 'block' : 'none';
    // The SPYGLASS is a clean lens — no reticle. (A weapon sniper scope keeps
    // its cross-lines to aim with.) Either way the FPS crosshair is hidden while
    // looking through a scope.
    this.view.ui.scopeOverlay.classList.toggle('spyglass', this.view.spyglassActive);
    // No crosshair while looking through a scope OR holding any tool (bucket/
    // compass/shovel/spyglass) — you're not aiming a weapon.
    this.view.ui.crosshair.style.display = scopeShowing || player.equippedTool ? 'none' : '';
    this.view.ui.crosshair.classList.toggle('cannon', player.atCannon);
    const shotgunCrosshair = !player.atCannon && weapon?.weaponId === 'blunderbuss';
    this.view.ui.crosshair.classList.toggle('shotgun', shotgunCrosshair);
    if (shotgunCrosshair) {
      this.view.ui.crosshair.style.setProperty('--shotgun-spread', `${this.view.getBlunderbussCrosshairSize(player)}px`);
    } else {
      this.view.ui.crosshair.style.removeProperty('--shotgun-spread');
    }

    const nearbyCannon = ship ? this.view.findNearbyCannonIndex(player, ship) : null;
    const repairSection = ship ? this.view.findRepairableHullSection(player, ship) : null;
    const lookInteraction = this.view.getLookInteraction(player, ship, nearbyCannon, repairSection);
    this.view.visibleInteractKind = null;

    if (player.state === 'respawning') {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = `Respawning in ${Math.max(1, Math.ceil(player.respawnTimer))}`;
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = 'Returning to your ship';
    } else if (player.atCannon) {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = '[X] Leave Cannon · [SPACE] Launch Yourself';
      this.view.ui.contextLabel.style.display = 'block';
      const superShot = player.superCannonballs > 0 && player.selectedCannonAmmo === 'cannonball'
        ? ` · SUPER x5 ready (${player.superCannonballs})`
        : '';
      this.view.ui.contextLabel.textContent = `Cannon ${player.cannonIndex + 1} · ${player.selectedCannonAmmo.replace('_', ' ')}${superShot} · [5/6/7] shot type`;
    } else if (player.atHelm) {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = '[X] Leave Helm';
      this.view.ui.contextLabel.style.display = 'block';
      if (ship) {
        this.view.ui.contextLabel.textContent = `${ship.anchored ? 'Anchored' : 'At the wheel'} · A/D steer · compass on starboard side`;
      } else {
        this.view.ui.contextLabel.textContent = 'At the wheel';
      }
    } else if (player.atSails) {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = '';
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = '';
    } else if (player.atCrowNest) {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = '[X] Climb Down';
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = 'Crow\'s nest · [X] remounts the ladder';
    } else if (player.mastClimb !== null) {
      // Mid-ladder: W/S climbs (server-driven), X lets go at the bottom.
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = `Climbing the mast — ${Math.round((player.mastClimb ?? 0) * 100)}%`;
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = 'W/S · climb — X · let go';
    } else if (lookInteraction) {
      this.view.visibleInteractKind = lookInteraction.kind;
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = lookInteraction.prompt;
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = lookInteraction.label;
    } else if (player.carryingChestId) {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = '[B] Drop Chest';
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = 'Carrying treasure · sell at Gold Hoarder or stow on ship';
    } else {
      this.view.ui.interactPrompt.style.display = 'none';
      // No busywork hints while bleeding out — the DOWNED banner is the guidance.
      const ambientLabel = player.state === 'downed'
        ? ''
        : player.state === 'swimming'
          ? 'Swimming · W follows look · Space up · Z down · LMB fire · Shift/RMB aim'
          : weapon?.weaponId === 'cutlass'
            ? `Cutlass · hold LMB to charge dash · Shift/RMB block · ${this.getKegSummary(player)}`
            : `[I] Supply wheel · Shift/RMB aim · ${this.getKegSummary(player)}`;
      this.view.ui.contextLabel.style.display = ambientLabel ? 'block' : 'none';
      this.view.ui.contextLabel.textContent = ambientLabel;
    }

    const heading = ((player.rotation.x * 180) / Math.PI + 360) % 360;
    this.view.ui.compassTape.style.transform = `translateX(${Math.round(-heading * 2.6)}px)`;
    this.view.ui.compassTape.style.opacity = '1';

    if (this.view.state.phase === 'ended') {
      if (this.view.state.winnerId === this.view.localPlayerId) {
        this.showVictory(player.kills, player.gold);
      } else {
        this.view.returnToLobbyAfterLoss(player.kills, player.gold, 'Crew lost');
      }
    } else if (player.state === 'eliminated') {
      this.view.returnToLobbyAfterLoss(player.kills, player.gold, 'Crew lost');
    } else if (player.state === 'respawning') {
      this.view.ui.deathScreen.style.display = 'none';
    }
  }

  private updateWeaponHud(activeSlot: number, activeWeapon: WeaponInstance | null, loadout: Array<WeaponInstance | null>) {
    for (const [slotIndex, slotEl] of this.view.ui.weaponSlots.entries()) {
      slotEl.classList.toggle('active', slotIndex === activeSlot);
      const weapon = loadout[slotIndex];
      const nameEl = slotEl.querySelector('.wname');
      const ammoEl = slotEl.querySelector('.ammo');
      if (nameEl) {
        nameEl.textContent = weapon ? WEAPONS[weapon.weaponId].name.replace(' Pistol', '') : 'Empty';
      }
      if (ammoEl) {
        ammoEl.textContent = weapon && WEAPONS[weapon.weaponId].ammoMax > 0
          ? `${weapon.ammo}/∞`
          : '∞';
      }
    }

    if (!activeWeapon || WEAPONS[activeWeapon.weaponId].ammoMax === 0) {
      this.view.ui.ammoCurrent.textContent = '∞';
      this.view.ui.ammoReserve.textContent = '∞';
      return;
    }

    this.view.ui.ammoCurrent.textContent = String(activeWeapon.ammo);
    this.view.ui.ammoReserve.textContent = '∞';
  }

  updateCombatHud(dt: number) {
    if (this.view.hitMarkerTimer > 0) {
      this.view.hitMarkerTimer = Math.max(0, this.view.hitMarkerTimer - dt);
    }
    const hitMarkerActive = this.view.hitMarkerTimer > 0;
    this.view.ui.hitMarker.classList.toggle('visible', hitMarkerActive);
    this.view.ui.hitMarker.classList.toggle('ship', hitMarkerActive && this.view.hitMarkerShip);
    this.view.ui.hitMarker.classList.toggle('shark', hitMarkerActive && this.view.hitMarkerShark);
    this.view.ui.hitMarker.classList.toggle('headshot', hitMarkerActive && this.view.hitMarkerHeadshot);
    this.view.ui.hitMarker.classList.toggle('kill', hitMarkerActive && this.view.hitMarkerKill);
    if (!hitMarkerActive) {
      this.view.hitMarkerShip = false;
      this.view.hitMarkerShark = false;
      this.view.hitMarkerHeadshot = false;
      this.view.hitMarkerKill = false;
    }

    if (this.view.floatingDamageIndicators.length === 0) return;

    this.view.renderer.camera.updateMatrixWorld();
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (let index = this.view.floatingDamageIndicators.length - 1; index >= 0; index--) {
      const indicator = this.view.floatingDamageIndicators[index];
      indicator.life += dt;
      indicator.worldPos.y += indicator.riseSpeed * dt;
      const progress = Math.min(1, indicator.life / indicator.duration);
      this.view.tempHudVector.copy(indicator.worldPos).project(this.view.renderer.camera);

      const visible = this.view.tempHudVector.z > -1 && this.view.tempHudVector.z < 1;
      if (!visible) {
        indicator.element.style.opacity = '0';
      } else {
        const x = (this.view.tempHudVector.x * 0.5 + 0.5) * width;
        const y = (-this.view.tempHudVector.y * 0.5 + 0.5) * height;
        indicator.element.style.left = `${x}px`;
        indicator.element.style.top = `${y}px`;
        indicator.element.style.opacity = `${1 - progress}`;
        indicator.element.style.transform = `translate(-50%, -50%) translateY(${-progress * 44}px) scale(${1 + (1 - progress) * 0.18})`;
      }

      if (progress >= 1) {
        indicator.element.remove();
        this.view.floatingDamageIndicators.splice(index, 1);
      }
    }
  }

  private setHull(fill: HTMLDivElement, label: HTMLElement, value: number) {
    const percent = Math.round(value * 100);
    fill.style.width = `${percent}%`;
    label.textContent = `${percent}%`;
  }

  /** Bilge water gauge — vertical ship-silhouette fill, trend arrow, red alarm > 75%.
   *  Visible only while the local player stands on a ship that's taking on water. */
  private updateWaterGauge(player: Player) {
    const ship = player.onShipId ? this.view.shipsById.get(player.onShipId) ?? null : null;
    const level = ship ? THREE.MathUtils.clamp(ship.waterLevel ?? 0, 0, 1) : 0;
    const show = !!ship
      && level > 0.02
      && player.state !== 'eliminated'
      && player.state !== 'respawning';
    this.view.ui.waterGauge.classList.toggle('visible', show);
    if (!show || !ship) {
      this.view.ui.waterGauge.classList.remove('danger');
      // Damp the ship-status widget tint back to normal when not flooding.
      this.view.ui.shipStatus.classList.remove('flooding', 'flooding-critical');
      return;
    }

    const pct = Math.round(level * 100);
    this.view.ui.waterGaugeFill.style.height = `${pct}%`;
    this.view.ui.waterGaugePct.textContent = `${pct}%`;
    const danger = level > 0.75;
    this.view.ui.waterGauge.classList.toggle('danger', danger);

    const rate = ship.floodingRate ?? 0;
    const trend = this.view.ui.waterGaugeTrend;
    if (rate > 0.0005) {
      trend.textContent = '▲';
      trend.style.color = danger ? '#ff8a6a' : '#ffb37a';
    } else if (rate < -0.0005) {
      trend.textContent = '▼';
      trend.style.color = '#7fe0a0';
    } else {
      trend.textContent = '▬';
      trend.style.color = '#9aa8b8';
    }

    // Tint the ship-status widget so the hull panel reads "flooding" at a glance.
    this.view.ui.shipStatus.classList.toggle('flooding', level > 0.02 && !danger);
    this.view.ui.shipStatus.classList.toggle('flooding-critical', danger);
  }

  private renderShipInventory(ship: Ship | null, player: Player) {
    const nearOwnShip = !!ship
      && player.shipId === ship.id
      && player.state === 'alive'
      && this.view.distance2D(player.position.x, player.position.z, ship.position.x, ship.position.z) < 58;
    const visible = !!ship
      && player.state !== 'swimming'
      && player.state !== 'eliminated'
      && player.state !== 'respawning'
      && (player.onShipId === ship.id || nearOwnShip);
    this.view.ui.shipInventory.classList.toggle('visible', visible);
    if (!ship) {
      this.shipInventorySignature = '';
      return;
    }

    const wood = this.view.getInventoryQty(ship, 'wood_plank');
    const cannonball = this.view.getInventoryQty(ship, 'cannonball');
    const firebomb = this.view.getInventoryQty(ship, 'firebomb_ball');
    const chainshot = this.view.getInventoryQty(ship, 'chainshot');
    const banana = this.view.getInventoryQty(ship, 'banana');
    const signature = `${ship.id}:${wood}:${cannonball}:${firebomb}:${chainshot}:${banana}`;
    if (signature === this.shipInventorySignature) return;
    this.shipInventorySignature = signature;
    this.view.ui.inventoryWood.textContent = String(wood);
    this.view.ui.inventoryCannonball.textContent = String(cannonball);
    this.view.ui.inventoryFirebomb.textContent = String(firebomb);
    this.view.ui.inventoryChainshot.textContent = String(chainshot);
    this.view.ui.inventoryBanana.textContent = String(banana);
  }

  private updateSupplyWheelCounts(player: Player) {
    for (const countEl of this.view.ui.pocketWheel.querySelectorAll<SVGTextElement>('[data-wheel-count]')) {
      const slot = Number(countEl.dataset.wheelCount);
      countEl.textContent = Number.isInteger(slot) ? String(this.view.getPocketWheelCount(player, slot)) : '0';
    }
    const heldSlot = this.view.input.getSupplyWheelHeldSlot();
    const equippedSlot = this.view.toolWheelSlot(player.equippedTool);
    for (const slice of this.view.ui.pocketWheel.querySelectorAll<SVGPathElement>('[data-wheel-slot]')) {
      const s = Number(slice.dataset.wheelSlot);
      // The mouse-hovered slot lights up brightest; also mark held-digit + equipped.
      slice.classList.toggle('hovered', s === this.view.wheelHoverSlot);
      slice.classList.toggle('active', s === heldSlot || s === equippedSlot || s === this.view.wheelHoverSlot);
    }
  }

  private goldLeaderboardSignature = '';
  private renderGoldLeaderboard(localPlayerId: string) {
    if (!this.view.state) return;
    const ranked = this.view.state.players
      .filter((p) => p.state !== 'eliminated')
      .slice()
      .sort((a, b) => b.gold - a.gold)
      .slice(0, 3);
    const signature = `${localPlayerId}:${ranked.map((p) => `${p.id}:${p.gold}`).join('|')}`;
    if (signature === this.goldLeaderboardSignature) return;
    this.goldLeaderboardSignature = signature;
    if (!ranked.length) {
      this.view.ui.goldLeaders.innerHTML = '';
      return;
    }
    this.view.ui.goldLeaders.innerHTML = ranked
      .map((p, index) => {
        const isSelf = p.id === localPlayerId;
        const safeName = (p.name || 'Pirate').replace(/[<>&"]/g, (c) =>
          c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;',
        );
        return `<div class="leader-row" data-rank="${index + 1}" data-self="${isSelf ? 1 : 0}">
          <span class="leader-rank">${index + 1}</span>
          <span class="leader-name">${safeName}</span>
          <span class="leader-amt">${p.gold}</span>
        </div>`;
      })
      .join('');
  }

  private renderShipUpgrades(ship: Ship | null) {
    if (!ship) {
      if (this.shipUpgradeSignature !== '') {
        this.view.ui.shipUpgrades.innerHTML = '';
        this.shipUpgradeSignature = '';
      }
      return;
    }

    const baseStats = SHIP_STATS[ship.type];
    const hasHull = ship.upgrades.some((u) => u.type === 'hull_reinforcement');
    const hasCannons = ship.upgrades.some((u) => u.type === 'charged_cannons');
    const hasSails = ship.upgrades.some((u) => u.type === 'swift_sails');

    const cannonBaseDmg = SHIP.CANNON_DAMAGE_HULL;
    const cannonDmg = Math.round(cannonBaseDmg * (hasCannons ? SHIP_UPGRADES.CANNON_DAMAGE_MULT : 1));
    const sailSpeed = (baseStats.maxSpeed * (hasSails ? SHIP_UPGRADES.SWIFT_SPEED_MULT : 1)).toFixed(1);

    const signature = [
      ship.id,
      ship.maxHull,
      hasHull ? 1 : 0,
      hasCannons ? 1 : 0,
      hasSails ? 1 : 0,
    ].join(':');
    if (signature === this.shipUpgradeSignature) return;
    this.shipUpgradeSignature = signature;

    const statRow = `
      <div class="ship-stat-row">
        <span class="ship-stat" data-stat="hull"${hasHull ? ' data-upgraded="1"' : ''}>
          <span class="ship-stat-icon">🛡</span>
          <span class="ship-stat-label">Hull</span>
          <span class="ship-stat-value">${hasHull ? `Reinforced <em>(−${Math.round((1 - SHIP_UPGRADES.HULL_INGRESS_MULT) * 100)}% flood)</em>` : 'Standard'}</span>
        </span>
        <span class="ship-stat" data-stat="cannons"${hasCannons ? ' data-upgraded="1"' : ''}>
          <span class="ship-stat-icon">✹</span>
          <span class="ship-stat-label">Cannon Dmg</span>
          <span class="ship-stat-value">${cannonDmg}${hasCannons ? ` <em>(+${Math.round((SHIP_UPGRADES.CANNON_DAMAGE_MULT - 1) * 100)}%)</em>` : ''}</span>
        </span>
        <span class="ship-stat" data-stat="sails"${hasSails ? ' data-upgraded="1"' : ''}>
          <span class="ship-stat-icon">✦</span>
          <span class="ship-stat-label">Top Speed</span>
          <span class="ship-stat-value">${sailSpeed}<span class="ship-stat-unit">kn</span>${hasSails ? ` <em>(+${Math.round((SHIP_UPGRADES.SWIFT_SPEED_MULT - 1) * 100)}%)</em>` : ''}</span>
        </span>
      </div>
    `;

    const pills = ship.upgrades.length === 0
      ? ''
      : `<div class="ship-upgrade-pills">${ship.upgrades.map((upgrade) => {
          const meta = this.view.getUpgradePresentation(upgrade.type);
          return `<span class="upgrade-pill" data-type="${upgrade.type}" title="${meta.name}: ${meta.effect}">${meta.icon} ${meta.short} <em>${meta.effect}</em></span>`;
        }).join('')}</div>`;

    this.view.ui.shipUpgrades.innerHTML = statRow + pills;
  }

  private renderKegStatus(player: Player) {
    const hidden = player.state === 'eliminated' || player.state === 'respawning';
    this.view.ui.kegStatus.classList.toggle('visible', !hidden);
    this.view.ui.kegStatusValue.textContent = this.getKegSummary(player);
  }

  private getKegSummary(player: Player) {
    const normal = player.kegs <= 0
      ? 'None remaining'
      : player.kegCooldown > 0
        ? `${Math.max(1, Math.ceil(player.kegCooldown))}s until second keg`
        : player.kegs === 1 ? '1 ready' : `${player.kegs} ready`;
    return player.megaKegs > 0 ? `Mega ${player.megaKegs} ready · ${normal}` : normal;
  }

  private getSpecialSummary(player: Player) {
    const parts: string[] = [];
    if (player.superCannonballs > 0) parts.push(`Super cannonball x${player.superCannonballs} (use cannonball at cannon)`);
    if (player.megaKegs > 0) parts.push(`Mega keg x${player.megaKegs} (hold G, click/place)`);
    if (player.tsunamiCharges > 0) parts.push(`Tsunami x${player.tsunamiCharges} [E]`);
    if (parts.length > 0) return `Powers READY: ${parts.join(' · ')}`;

    const next = player.playerKillStreak < 5
      ? { count: 5, reward: 'super cannonball' }
      : player.playerKillStreak < 10
        ? { count: 10, reward: 'mega keg' }
        : player.playerKillStreak < 20
          ? { count: 20, reward: 'tsunami' }
          : null;
    return next
      ? `Powers: streak ${player.playerKillStreak}/${next.count} for ${next.reward} (5 super cannonball, 10 mega keg, 20 tsunami)`
      : `Powers: streak ${player.playerKillStreak} · all rewards unlocked at 5/10/20`;
  }

  private getObjectiveSummary(
    player: Player,
    ship: Ship | null,
    context: {
      chestsInHold: number;
      mappedIsland: Island | null;
      closestHoarder: { npc: IslandNpc; island: Island; distance: number } | null;
      outsideStorm: boolean;
      shipCritical: boolean;
      shipOnFire: boolean;
    },
  ) {
    if (context.outsideStorm) return 'Objective: sail inside the storm circle';
    if (context.shipCritical) return 'Objective: repair hull before the ship goes down';
    if (context.shipOnFire) return 'Objective: douse fire at the repair point';
    if (player.carryingChestId && context.closestHoarder) {
      return `Objective: sell chest at ${context.closestHoarder.island.name}`;
    }
    if (context.chestsInHold > 0 && context.closestHoarder) {
      return `Objective: deliver ${context.chestsInHold} chest${context.chestsInHold === 1 ? '' : 's'} to ${context.closestHoarder.island.name}`;
    }
    if (context.mappedIsland) return `Objective: dig Gold Hoarder chests on ${context.mappedIsland.name}`;
    if (player.gold >= ECONOMY.GOLD_WIN_TARGET * 0.72) return 'Objective: protect your lead and finish the gold run';
    if (ship && ship.upgrades.length < 2) return 'Objective: claim upgrades, raid ships, and sell treasure';
    return 'Objective: raid ships, sell treasure, and stay ahead of the storm';
  }

  pushFeed(message: string, color = '#e7e1d4') {
    const item = document.createElement('div');
    item.textContent = message;
    item.style.color = color;
    item.style.marginBottom = '8px';
    item.style.textShadow = '0 2px 6px rgba(0, 0, 0, 0.55)';
    this.view.ui.killFeed.prepend(item);
    while (this.view.ui.killFeed.childElementCount > 5) {
      this.view.ui.killFeed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(-6px)';
      item.style.transition = 'opacity 200ms ease, transform 200ms ease';
    }, 3000);
    window.setTimeout(() => item.remove(), 3300);
  }

  showVictory(kills: number, gold: number) {
    this.view.ui.winStats.innerHTML = `<div>Kills: ${kills}</div><div>Gold: ${gold}</div>`;
    this.view.ui.winScreen.style.display = 'flex';
  }
}
