/** Typed handles to every static DOM node the in-match HUD drives. */

export type UiRefs = {
  loadingScreen: HTMLDivElement;
  loadingBar: HTMLDivElement;
  loadingText: HTMLDivElement;
  compassTape: HTMLDivElement;
  stormPhase: HTMLDivElement;
  stormTimer: HTMLDivElement;
  stormWarning: HTMLDivElement;
  downedBanner: HTMLDivElement;
  shipsAlive: HTMLDivElement;
  goldAmount: HTMLDivElement;
  goldLeaders: HTMLDivElement;
  killCount: HTMLDivElement;
  healthFill: HTMLDivElement;
  armorFill: HTMLDivElement;
  /** One-line breach readout that replaced the four hull-section bars. */
  shipLeaks: HTMLDivElement;
  sailStatus: HTMLDivElement;
  shipStatus: HTMLDivElement;
  /** Hull-panel heading — names the hull CLASS of the ship you are tracking. */
  shipStatusTitle: HTMLHeadingElement;
  shipUpgrades: HTMLDivElement;
  ammoCurrent: HTMLSpanElement;
  ammoReserve: HTMLSpanElement;
  reloadIndicator: HTMLDivElement;
  weaponSlots: HTMLDivElement[];
  inventoryWood: HTMLSpanElement;
  inventoryCannonball: HTMLSpanElement;
  inventoryFirebomb: HTMLSpanElement;
  inventoryChainshot: HTMLSpanElement;
  inventoryBanana: HTMLSpanElement;
  shipInventory: HTMLDivElement;
  kegStatus: HTMLDivElement;
  kegStatusValue: HTMLDivElement;
  interactPrompt: HTMLDivElement;
  contextLabel: HTMLDivElement;
  waterGauge: HTMLDivElement;
  waterGaugeTitle: HTMLDivElement;
  waterGaugeFill: HTMLDivElement;
  waterGaugeTrend: HTMLSpanElement;
  waterGaugePct: HTMLSpanElement;
  barrelPanel: HTMLDivElement;
  barrelPanelLoot: HTMLDivElement;
  barrelPanelInventory: HTMLDivElement;
  crosshair: HTMLDivElement;
  hitMarker: HTMLDivElement;
  damageIndicatorLayer: HTMLDivElement;
  scopeOverlay: HTMLDivElement;
  killFeed: HTMLDivElement;
  damageVignette: HTMLDivElement;
  knockbackFlash: HTMLDivElement;
  tradeUi: HTMLDivElement;
  yourTradeItems: HTMLDivElement;
  theirTradeItems: HTMLDivElement;
  tradeConfirm: HTMLButtonElement;
  tradeCancel: HTMLButtonElement;
  tradeTimer: HTMLDivElement;
  deathScreen: HTMLDivElement;
  deathStats: HTMLDivElement;
  winScreen: HTMLDivElement;
  winStats: HTMLDivElement;
  minimapCanvas: HTMLCanvasElement;
  mapOverlay: HTMLDivElement;
  mapCanvas: HTMLCanvasElement;
  mapSubtitle: HTMLDivElement;
  islandBanner: HTMLDivElement;
  /** Staged match start (crew found → countdown → horn). */
  matchStartSeq: HTMLDivElement;
  matchStartCrews: HTMLSpanElement;
  matchStartIsland: HTMLDivElement;
  matchStartCount: HTMLDivElement;
  matchStartBanner: HTMLDivElement;
  matchStartHint: HTMLDivElement;
  /** Screen-projected "board your ship" marker over the player's own hull. */
  ownShipMarker: HTMLDivElement;
  ownShipMarkerDistance: HTMLSpanElement;
  /** Crews-afloat chip — pulsed on every crew elimination. */
  playerCount: HTMLDivElement;
  pocketWheel: HTMLDivElement;
  pocketWheelStats: HTMLDivElement;
  mapWheel: HTMLDivElement;
  mapWheelList: HTMLDivElement;
  pocketStrip: HTMLDivElement;
  treasureChart: HTMLDivElement;
  treasureChartCanvas: HTMLCanvasElement;
  treasureChartIsland: HTMLDivElement;
  treasureChartRoute: HTMLDivElement;
  brProgressFeed: HTMLDivElement;
};

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return element as T;
}

/** Resolves every HUD element once at construction; throws if the DOM is missing one. */
export function buildUiRefs(): UiRefs {
  return {
    loadingScreen: requireElement('loading-screen'),
    loadingBar: requireElement('loading-bar'),
    loadingText: requireElement('loading-text'),
    compassTape: requireElement('compass-tape'),
    stormPhase: requireElement('storm-phase'),
    stormTimer: requireElement('storm-timer'),
    stormWarning: requireElement('storm-warning'),
    downedBanner: requireElement('downed-banner'),
    shipsAlive: requireElement('ships-alive'),
    goldAmount: requireElement('gold-amount'),
    goldLeaders: requireElement('gold-leaders'),
    killCount: requireElement('kill-count'),
    healthFill: requireElement('health-fill'),
    armorFill: requireElement('armor-fill'),
    shipLeaks: requireElement('ship-leaks'),
    sailStatus: requireElement('sail-status'),
    shipStatus: requireElement('ship-status'),
    shipStatusTitle: requireElement('ship-status-title'),
    shipUpgrades: requireElement('ship-upgrades'),
    ammoCurrent: requireElement('ammo-current'),
    ammoReserve: requireElement('ammo-reserve'),
    reloadIndicator: requireElement('reload-indicator'),
    weaponSlots: [0, 1, 2, 3].map((index) => requireElement(`slot-${index}`)),
    inventoryWood: requireElement('inv-wood'),
    inventoryCannonball: requireElement('inv-cannonball'),
    inventoryFirebomb: requireElement('inv-firebomb'),
    inventoryChainshot: requireElement('inv-chainshot'),
    inventoryBanana: requireElement('inv-banana'),
    shipInventory: requireElement('ship-inventory'),
    kegStatus: requireElement('keg-status'),
    kegStatusValue: requireElement('keg-status-value'),
    interactPrompt: requireElement('interact-prompt'),
    contextLabel: requireElement('context-label'),
    waterGauge: requireElement('water-gauge'),
    waterGaugeTitle: requireElement('wg-title'),
    waterGaugeFill: requireElement('wg-fill'),
    waterGaugeTrend: requireElement('wg-trend'),
    waterGaugePct: requireElement('wg-pct'),
    barrelPanel: requireElement('barrel-panel'),
    barrelPanelLoot: requireElement('barrel-panel-loot'),
    barrelPanelInventory: requireElement('barrel-panel-inventory'),
    crosshair: requireElement('crosshair'),
    hitMarker: requireElement('hit-marker'),
    damageIndicatorLayer: requireElement('damage-indicator-layer'),
    scopeOverlay: requireElement('scope-overlay'),
    killFeed: requireElement('kill-feed'),
    damageVignette: requireElement('damage-vignette'),
    knockbackFlash: requireElement('knockback-flash'),
    tradeUi: requireElement('trade-ui'),
    yourTradeItems: requireElement('your-trade-items'),
    theirTradeItems: requireElement('their-trade-items'),
    tradeConfirm: requireElement('trade-confirm'),
    tradeCancel: requireElement('trade-cancel'),
    tradeTimer: requireElement('trade-timer'),
    deathScreen: requireElement('death-screen'),
    deathStats: requireElement('death-stats'),
    winScreen: requireElement('win-screen'),
    winStats: requireElement('win-stats'),
    minimapCanvas: requireElement('minimap-canvas'),
    mapOverlay: requireElement('map-overlay'),
    mapCanvas: requireElement('map-canvas'),
    mapSubtitle: requireElement('map-subtitle'),
    islandBanner: requireElement('island-banner'),
    matchStartSeq: requireElement('match-start-seq'),
    matchStartCrews: requireElement('ms-crews'),
    matchStartIsland: requireElement('ms-island'),
    matchStartCount: requireElement('ms-count'),
    matchStartBanner: requireElement('ms-banner'),
    matchStartHint: requireElement('ms-hint'),
    ownShipMarker: requireElement('own-ship-marker'),
    ownShipMarkerDistance: requireElement('osm-dist'),
    playerCount: requireElement('player-count'),
    pocketWheel: requireElement('pocket-wheel'),
    pocketWheelStats: requireElement('pocket-wheel-stats'),
    mapWheel: requireElement('map-wheel'),
    mapWheelList: requireElement('map-wheel-list'),
    pocketStrip: requireElement('pocket-strip'),
    treasureChart: requireElement('treasure-chart'),
    treasureChartCanvas: requireElement('treasure-chart-canvas'),
    treasureChartIsland: requireElement('treasure-chart-island'),
    treasureChartRoute: requireElement('treasure-chart-route'),
    brProgressFeed: requireElement('br-progress-feed'),
  };
}
