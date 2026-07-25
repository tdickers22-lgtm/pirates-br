/**
 * Draws every chart surface: the corner minimap, the fullscreen battle map, the
 * per-island treasure chart and the map-selection wheel. Owns the map's own UI
 * state (open flag, zoom, cached island bitmaps) and reads the world through a
 * narrow `MapView`.
 */
import * as THREE from 'three';
import { WORLD } from '../../shared/constants/index.js';
import type { GameState, Island, IslandNpc, Player, Ship, TreasureChest } from '../../shared/types/index.js';
import { getIslandMaxRadius, getIslandSurfacePoint, getIslandSurfaceY } from '../../shared/utils/index.js';
import { BIOME_PALETTES } from '../../shared/props.js';
import type { InputManager } from '../input/InputManager.js';
import type { Renderer } from '../rendering/Renderer.js';
import type { UiRefs } from './UiRefs.js';

export type MapView = {
  readonly ui: UiRefs;
  readonly input: InputManager;
  readonly renderer: Renderer;
  readonly state: GameState | null;
  formatStormTimer(seconds: number): string;
  getClosestGoldHoarder(player: Player): { npc: IslandNpc; island: Island; distance: number } | null;
  getLocalPlayer(): Player | null;
  getNearestIsland(px: number, pz: number): Island | null;
  getStormTimerSeconds(): number;
  getTrackedShip(): Ship | null;
};

export class MapRenderer {
  constructor(private readonly view: MapView) {}

  mapOpen = false;
  /** Full-map zoom (1 = whole world fit; scroll to zoom in, pans to the player). */
  mapZoom = 1;
  /** Cached per-island land-shape bitmaps for the chart. The world is fixed, so
   *  each island's true above-water footprint (archipelago islets, crescent bays,
   *  twin saddles) is rasterized once from getIslandSurfaceY and reused. */
  private readonly islandChartCache = new Map<string, { canvas: HTMLCanvasElement; extent: number }>();
  private treasureChartSignature = '';

  drawMaps() {
    if (!this.view.state) return;
    const minimapCtx = this.view.ui.minimapCanvas.getContext('2d');
    if (minimapCtx) {
      this.renderBattleMap(minimapCtx, this.view.ui.minimapCanvas.width, this.view.ui.minimapCanvas.height, false);
    }
    if (this.mapOpen) this.drawFullMap();
  }

  /** The opened map redraws every frame while it's up, so your arrow and the
   *  other ships track live as you move/turn (the minimap stays throttled). */
  drawFullMap() {
    if (!this.view.state || !this.mapOpen) return;
    const mapCtx = this.view.ui.mapCanvas.getContext('2d');
    if (mapCtx) {
      this.renderBattleMap(mapCtx, this.view.ui.mapCanvas.width, this.view.ui.mapCanvas.height, true);
    }
  }

  /** Quest-maps wheel page: one row per held chart — digit or click equips it
   *  as the ACTIVE map (red-X chart bottom-right + hoarder sale bonus). */
  private mapWheelSignature = '';
  renderMapWheel(player: Player) {
    const maps = player.questMaps ?? [];
    const signature = `${maps.join(',')}|${player.treasureMapIslandId ?? ''}`;
    if (signature === this.mapWheelSignature) return;
    this.mapWheelSignature = signature;
    const list = this.view.ui.mapWheelList;
    list.textContent = '';
    if (maps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mw-empty';
      empty.textContent = 'No charts held — visit a Gold Hoarder for a treasure map.';
      list.appendChild(empty);
      return;
    }
    maps.forEach((islandId, index) => {
      const island = this.view.state?.islands.find((candidate) => candidate.id === islandId) ?? null;
      const digs = island
        ? island.chests.filter((chest) => chest.buried && chest.digProgress < 1 && !chest.opened).length
        : 0;
      const entry = document.createElement('div');
      entry.className = `mw-entry${islandId === player.treasureMapIslandId ? ' active' : ''}`;
      const digit = document.createElement('span');
      digit.className = 'mw-digit';
      digit.textContent = String(index + 1);
      const name = document.createElement('span');
      name.textContent = island?.name ?? 'Uncharted isle';
      name.style.flex = '1';
      const marks = document.createElement('span');
      marks.className = 'mw-x';
      marks.textContent = `${'✕'.repeat(Math.min(3, Math.max(0, digs)))}${digs > 3 ? '+' : ''}${digs === 0 ? '·dug out' : ''}`;
      const activeTag = document.createElement('span');
      activeTag.textContent = islandId === player.treasureMapIslandId ? 'ACTIVE' : '';
      activeTag.style.color = '#f0c86a';
      entry.append(digit, name, marks, activeTag);
      entry.addEventListener('click', () => { this.pendingSelectMapFromUi = islandId; });
      list.appendChild(entry);
    });
  }
  pendingSelectMapFromUi: string | null = null;

  renderTreasureInventoryChart(
    player: Player,
    mappedIsland: Island | null,
    closestHoarder: { npc: IslandNpc; island: Island; distance: number } | null,
  ) {
    const chartIsland = mappedIsland ?? (player.carryingChestId ? closestHoarder?.island ?? null : null);
    if (!chartIsland) {
      this.view.ui.treasureChart.classList.remove('visible');
      this.treasureChartSignature = '';
      return;
    }

    this.view.ui.treasureChart.classList.add('visible');
    const treasureMarks = mappedIsland ? this.getTreasureChartChests(chartIsland) : [];
    const routeText = player.carryingChestId
      ? `Return chest to Gold Hoarder at ${closestHoarder?.island.name ?? chartIsland.name}`
      : treasureMarks.length > 0
        ? `${treasureMarks.length} buried X mark${treasureMarks.length === 1 ? '' : 's'} | shovel in pocket`
        : `No buried marks left | return to ${closestHoarder?.island.name ?? 'Gold Hoarder'}`;
    const islandText = mappedIsland ? `Gold Hoarder chart: ${chartIsland.name}` : 'Gold Hoarder return';
    if (this.view.ui.treasureChartIsland.textContent !== islandText) this.view.ui.treasureChartIsland.textContent = islandText;
    if (this.view.ui.treasureChartRoute.textContent !== routeText) this.view.ui.treasureChartRoute.textContent = routeText;

    const markSig = treasureMarks
      .map((chest) => `${chest.id}:${Math.round(chest.digProgress * 100)}:${chest.carriedByPlayerId ?? ''}:${chest.storedOnShipId ?? ''}`)
      .join(',');
    const hoarderSig = closestHoarder ? closestHoarder.island.id : 'none';
    const signature = `${chartIsland.id}:${mappedIsland ? 1 : 0}:${player.carryingChestId ?? ''}:${markSig}:${hoarderSig}:${this.view.ui.treasureChartCanvas.width}x${this.view.ui.treasureChartCanvas.height}`;
    if (signature === this.treasureChartSignature) return;
    this.treasureChartSignature = signature;

    const canvas = this.view.ui.treasureChartCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const parchment = ctx.createLinearGradient(0, 0, width, height);
    parchment.addColorStop(0, '#e3ca8a');
    parchment.addColorStop(0.55, '#d2ae63');
    parchment.addColorStop(1, '#b9853f');
    ctx.fillStyle = parchment;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = 'rgba(75, 45, 18, 0.14)';
    ctx.lineWidth = 1;
    for (let x = 14; x < width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 16, height);
      ctx.stroke();
    }
    for (let y = 12; y < height; y += 22) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y + 10);
      ctx.stroke();
    }
    ctx.restore();

    const cx = width * 0.5;
    const cy = height * 0.53;
    const mapScale = Math.min(width, height) * 0.38 / Math.max(1, chartIsland.radius);
    const toMap = (x: number, z: number) => ({
      x: cx + (x - chartIsland.position.x) * mapScale,
      y: cy + (z - chartIsland.position.z) * mapScale,
    });

    ctx.save();
    ctx.fillStyle = '#8a6b36';
    ctx.strokeStyle = 'rgba(60, 35, 12, 0.76)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const segments = this.view.renderer.getQuality() === 'low' ? 24 : this.view.renderer.getQuality() === 'balanced' ? 32 : 42;
    for (let segment = 0; segment <= segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const point = getIslandSurfacePoint(chartIsland, 0.98, angle, 0);
      const mapped = toMap(point.x, point.z);
      if (segment === 0) ctx.moveTo(mapped.x, mapped.y);
      else ctx.lineTo(mapped.x, mapped.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(67, 88, 35, 0.58)';
    ctx.beginPath();
    for (let segment = 0; segment <= segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const point = getIslandSurfacePoint(chartIsland, 0.54, angle, 0);
      const mapped = toMap(point.x, point.z);
      if (segment === 0) ctx.moveTo(mapped.x, mapped.y);
      else ctx.lineTo(mapped.x, mapped.y);
    }
    ctx.closePath();
    ctx.fill();

    if (chartIsland.dock) {
      const dock = chartIsland.dock;
      const mapped = toMap(dock.position.x, dock.position.z);
      ctx.save();
      ctx.translate(mapped.x, mapped.y);
      ctx.rotate(Math.PI - dock.rotation);
      ctx.fillStyle = '#5f3719';
      ctx.fillRect(-dock.width * mapScale * 0.5, -dock.length * mapScale * 0.5, dock.width * mapScale, dock.length * mapScale);
      ctx.restore();
    }

    for (const chest of treasureMarks) {
      const mapped = toMap(chest.position.x, chest.position.z);
      this.drawTreasureX(ctx, mapped.x, mapped.y, 10, '#741616');
    }

    const hoarder = (chartIsland.npcs ?? []).find((npc) => npc.role === 'gold_hoarder') ?? null;
    if (hoarder) {
      const mapped = toMap(hoarder.position.x, hoarder.position.z);
      ctx.fillStyle = '#f0c65a';
      ctx.strokeStyle = '#3c240d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mapped.x, mapped.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2b1a08';
      ctx.font = '700 7px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GH', mapped.x, mapped.y + 0.2);
    }

    ctx.restore();
  }

  private getTreasureChartChests(island: Island): TreasureChest[] {
    return island.chests.filter((chest) =>
      chest.buried
      && chest.digProgress < 1
      && !chest.opened
      && !chest.carriedByPlayerId
      && !chest.storedOnShipId
      && !chest.floating
    );
  }

  private drawTreasureX(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, size * 0.22);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - size * 0.48, y - size * 0.48);
    ctx.lineTo(x + size * 0.48, y + size * 0.48);
    ctx.moveTo(x + size * 0.48, y - size * 0.48);
    ctx.lineTo(x - size * 0.48, y + size * 0.48);
    ctx.stroke();
    ctx.restore();
  }

  /** Draw a charted-POI marker as a monochrome gold vector glyph in the map's
   *  parchment palette. Replaces OS colour emoji (which rendered as glossy Apple
   *  art on Mac and tofu boxes / different art elsewhere — non-deterministic). */
  private drawPoiIcon(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, s = 6) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = Math.max(1, s * 0.26);
    ctx.strokeStyle = 'rgba(6, 14, 26, 0.92)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const gold = '#e7c766';
    const dark = 'rgba(6, 14, 26, 0.9)';
    ctx.fillStyle = gold;
    const tri = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath();
    };
    switch (kind) {
      case 'volcano':
        ctx.beginPath(); ctx.moveTo(-s, s * 0.8); ctx.lineTo(-s * 0.34, -s * 0.4);
        ctx.lineTo(s * 0.34, -s * 0.4); ctx.lineTo(s, s * 0.8); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e2552e'; ctx.beginPath(); ctx.arc(0, -s * 0.4, s * 0.24, 0, Math.PI * 2); ctx.fill();
        break;
      case 'peak':
        tri(-s, s * 0.8, 0, -s * 0.9, s, s * 0.8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#f4e8c6'; tri(-s * 0.32, -s * 0.12, 0, -s * 0.9, s * 0.32, -s * 0.12); ctx.fill();
        break;
      case 'fort': // skull
        ctx.beginPath(); ctx.arc(0, -s * 0.1, s * 0.72, Math.PI, 0); ctx.lineTo(s * 0.48, s * 0.55); ctx.lineTo(-s * 0.48, s * 0.55); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = dark;
        ctx.beginPath(); ctx.arc(-s * 0.3, -s * 0.1, s * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(s * 0.3, -s * 0.1, s * 0.2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'anchor': // shipwreck
        ctx.beginPath();
        ctx.arc(0, -s * 0.68, s * 0.26, 0, Math.PI * 2);
        ctx.moveTo(0, -s * 0.42); ctx.lineTo(0, s * 0.6);
        ctx.moveTo(-s * 0.5, s * 0.05); ctx.lineTo(s * 0.5, s * 0.05);
        ctx.moveTo(-s * 0.6, s * 0.3); ctx.quadraticCurveTo(0, s * 0.95, s * 0.6, s * 0.3);
        ctx.stroke();
        break;
      case 'tower': // watchtower
        ctx.beginPath(); ctx.moveTo(-s * 0.42, s * 0.85); ctx.lineTo(-s * 0.28, -s * 0.4); ctx.lineTo(s * 0.28, -s * 0.4); ctx.lineTo(s * 0.42, s * 0.85);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.rect(-s * 0.42, -s * 0.78, s * 0.84, s * 0.36); ctx.fill(); ctx.stroke();
        break;
      case 'stones': // standing stones (trilithon)
        ctx.beginPath();
        ctx.rect(-s * 0.72, -s * 0.35, s * 0.36, s * 1.15);
        ctx.rect(s * 0.36, -s * 0.35, s * 0.36, s * 1.15);
        ctx.rect(-s * 0.85, -s * 0.72, s * 1.7, s * 0.36);
        ctx.fill(); ctx.stroke();
        break;
      case 'arch':
        ctx.beginPath(); ctx.arc(0, s * 0.45, s * 0.78, Math.PI, 0); ctx.stroke();
        break;
      case 'mug': // tavern
        ctx.beginPath(); ctx.rect(-s * 0.5, -s * 0.35, s * 0.82, s * 1.0); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(s * 0.36, s * 0.15, s * 0.32, -Math.PI * 0.5, Math.PI * 0.5); ctx.stroke();
        ctx.fillStyle = '#f4e8c6'; ctx.beginPath(); ctx.ellipse(-s * 0.09, -s * 0.35, s * 0.44, s * 0.2, 0, 0, Math.PI * 2); ctx.fill();
        break;
      case 'coin': // gold hoarder
        ctx.beginPath(); ctx.arc(0, 0, s * 0.72, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#8a6d1f'; ctx.font = `bold ${Math.round(s * 1.1)}px Georgia, serif`; ctx.fillText('$', 0, s * 0.08);
        break;
      case 'hammer': // shipwright
        ctx.beginPath(); ctx.moveTo(0, s * 0.85); ctx.lineTo(0, -s * 0.2); ctx.stroke();
        ctx.beginPath(); ctx.rect(-s * 0.5, -s * 0.6, s * 1.0, s * 0.42); ctx.fill(); ctx.stroke();
        break;
      case 'crystal': // oracle
        ctx.beginPath(); ctx.moveTo(0, -s * 0.9); ctx.lineTo(s * 0.6, -s * 0.05); ctx.lineTo(0, s * 0.9); ctx.lineTo(-s * 0.6, -s * 0.05); ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case 'hood': // mysterious stranger
        ctx.beginPath(); ctx.moveTo(0, -s * 0.9); ctx.quadraticCurveTo(s * 0.72, -s * 0.15, s * 0.5, s * 0.7);
        ctx.lineTo(-s * 0.5, s * 0.7); ctx.quadraticCurveTo(-s * 0.72, -s * 0.15, 0, -s * 0.9); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(0, s * 0.08, s * 0.3, s * 0.4, 0, 0, Math.PI * 2); ctx.fill();
        break;
      case 'cave':
        ctx.fillStyle = dark;
        ctx.beginPath(); ctx.arc(0, s * 0.5, s * 0.7, Math.PI, 0); ctx.lineTo(s * 0.7, s * 0.5); ctx.lineTo(-s * 0.7, s * 0.5); ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      case 'noose': // gallows
        ctx.beginPath(); ctx.moveTo(0, -s * 0.9); ctx.lineTo(0, -s * 0.1); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, s * 0.32, s * 0.42, 0, Math.PI * 2); ctx.stroke();
        break;
      case 'ribs': // whale skeleton
        ctx.beginPath(); ctx.moveTo(-s * 0.85, s * 0.55); ctx.lineTo(s * 0.85, s * 0.55); ctx.stroke();
        for (const rx of [-0.45, 0, 0.45]) {
          ctx.beginPath(); ctx.arc(rx * s, s * 0.55, s * 0.62, Math.PI, 0); ctx.stroke();
        }
        break;
      case 'tentacle': // kraken wreck
        ctx.beginPath();
        ctx.moveTo(-s * 0.6, s * 0.85);
        ctx.quadraticCurveTo(-s * 0.9, -s * 0.1, 0, -s * 0.25);
        ctx.quadraticCurveTo(s * 0.85, -s * 0.4, s * 0.5, -s * 0.9);
        ctx.lineWidth = Math.max(1.4, s * 0.34); ctx.stroke();
        ctx.fillStyle = '#e7c766';
        for (const [dx, dy] of [[-0.55, 0.45], [-0.3, -0.02], [0.25, -0.28]]) {
          ctx.beginPath(); ctx.arc(dx * s, dy * s, s * 0.12, 0, Math.PI * 2); ctx.fill();
        }
        break;
    }
    ctx.restore();
  }

  private renderBattleMap(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    fullscreen: boolean,
  ) {
    if (!this.view.state) return;

    const trackedShip = this.view.getTrackedShip();
    const localPlayer = this.view.getLocalPlayer();
    // The "you" marker follows the PLAYER's live position and current look yaw,
    // so it moves when you walk/sail (you're carried by the deck) and rotates
    // when you turn — even while parked on an anchored ship. Your ship is drawn
    // as its own marker below.
    const localX = localPlayer?.position.x ?? trackedShip?.position.x ?? 0;
    const localZ = localPlayer?.position.z ?? trackedShip?.position.z ?? 0;
    const localHeading = this.view.input.getYaw();
    // Whole-world fit, then a zoom the player can scroll on the full map. Zoomed
    // in, pan so the player stays centred; at 1× show the entire Shattered Reach.
    const baseScale = Math.min(width, height) / WORLD.SIZE;
    const zoom = fullscreen ? this.mapZoom : 1;
    const scale = baseScale * zoom;
    const focusX = zoom > 1.001 ? localX : 0;
    const focusZ = zoom > 1.001 ? localZ : 0;
    const centerX = width * 0.5 - focusX * scale;
    const centerY = height * 0.5 - focusZ * scale;
    const stormX = centerX + this.view.state.storm.centerX * scale;
    const stormY = centerY + this.view.state.storm.centerZ * scale;
    const stormRadius = this.view.state.storm.safeRadius * scale;
    const nextStormX = centerX + this.view.state.storm.nextCenterX * scale;
    const nextStormY = centerY + this.view.state.storm.nextCenterZ * scale;
    const nextRadius = Math.max(0, this.view.state.storm.nextRadius * scale);
    const timerSeconds = this.view.getStormTimerSeconds();
    const stormLabel = `${this.view.state.storm.shrinking ? 'CLOSING' : 'NEXT'} ${this.view.formatStormTimer(timerSeconds)}`;

    ctx.clearRect(0, 0, width, height);

    const oceanGradient = ctx.createLinearGradient(0, 0, 0, height);
    oceanGradient.addColorStop(0, fullscreen ? '#0d213d' : '#102947');
    oceanGradient.addColorStop(1, fullscreen ? '#06111f' : '#081321');
    ctx.fillStyle = oceanGradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = fullscreen ? 'rgba(150, 192, 237, 0.08)' : 'rgba(150, 192, 237, 0.06)';
    ctx.lineWidth = 1;
    const gridStep = WORLD.SIZE / 8;
    for (let world = -WORLD.HALF; world <= WORLD.HALF; world += gridStep) {
      const x = centerX + world * scale;
      const y = centerY + world * scale;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = fullscreen ? 'rgba(110, 70, 170, 0.4)' : 'rgba(110, 70, 170, 0.34)';
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.arc(stormX, stormY, stormRadius, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();

    if (nextRadius > 0 && nextRadius < stormRadius - 1) {
      ctx.save();
      ctx.setLineDash(fullscreen ? [16, 12] : [8, 6]);
      ctx.strokeStyle = 'rgba(233, 244, 255, 0.78)';
      ctx.lineWidth = fullscreen ? 3 : 2;
      ctx.beginPath();
      ctx.arc(nextStormX, nextStormY, nextRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = this.view.state.storm.shrinking ? 'rgba(188, 214, 255, 0.95)' : 'rgba(143, 114, 255, 0.95)';
    ctx.lineWidth = fullscreen ? 4 : 2.5;
    ctx.beginPath();
    ctx.arc(stormX, stormY, stormRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Storm countdown chip — minimap only. On the fullscreen map the "BATTLE MAP"
    // HTML title sits in this same corner and the countdown is already the panel
    // subtitle, so drawing the chip here just smeared over the title.
    if (!fullscreen) {
      ctx.save();
      ctx.fillStyle = 'rgba(5, 14, 28, 0.68)';
      ctx.strokeStyle = 'rgba(201, 168, 76, 0.32)';
      ctx.lineWidth = 1.2;
      ctx.fillRect(8, 8, 104, 24);
      ctx.strokeRect(8, 8, 104, 24);
      ctx.fillStyle = this.view.state.storm.shrinking ? '#d7e8ff' : '#c9a84c';
      ctx.font = '700 10px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(stormLabel, 15, 20);
      ctx.restore();
    }

    ctx.save();
    for (const island of this.view.state.islands) {
      this.drawIslandChart(ctx, island, centerX, centerY, scale, fullscreen);
    }
    ctx.restore();

    // Full map: peak/volcano markers, big landmarks, and island name labels.
    if (fullscreen) {
      ctx.save();
      ctx.textAlign = 'center';
      for (const island of this.view.state.islands) {
        const ix = centerX + island.position.x * scale;
        const iy = centerY + island.position.z * scale;
        const rPx = getIslandMaxRadius(island) * scale;
        const isVolcanic = island.profile.biome === 'volcanic';
        if (isVolcanic || island.profile.terrainStyle === 'mountain') {
          this.drawPoiIcon(ctx, isVolcanic ? 'volcano' : 'peak', ix, iy, Math.max(7, Math.min(13, rPx * 0.28)));
        }
        // Big charted landmarks — the "where to raid" markers SoT shows.
        for (const prop of island.props ?? []) {
          // Only sea-visible hero landmarks are charted — intimate story
          // vignettes (smuggler cache, dig site, parley table…) stay
          // uncharted so finding them means something.
          const kind = prop.type === 'shipwreck' ? 'anchor'
            : prop.type === 'watchtower' ? 'tower'
              : prop.type === 'standing_stones' ? 'stones'
                : prop.type === 'fort' ? 'fort'
                  : prop.type === 'rock_arch' ? 'arch'
                    : prop.type === 'gallows' ? 'noose'
                      : prop.type === 'whale_skeleton' ? 'ribs'
                        : prop.type === 'kraken_wreck' ? 'tentacle'
                          : prop.type === 'skull_totem' ? 'fort'
                            : prop.type === 'wrecker_tower' ? 'tower'
                              : prop.type === 'mine_head' ? 'hammer'
                                : prop.type === 'widow_memorial' ? 'hood' : '';
          if (!kind) continue;
          this.drawPoiIcon(ctx, kind, centerX + prop.x * scale, centerY + prop.z * scale, kind === 'fort' ? 8 : 6);
        }
        // Services & POIs: tavern, vendor NPCs, and cave mouths.
        if (island.tavern) {
          this.drawPoiIcon(ctx, 'mug', centerX + island.tavern.position.x * scale, centerY + island.tavern.position.z * scale, 6);
        }
        for (const npc of island.npcs ?? []) {
          const nkind = npc.role === 'gold_hoarder' ? 'coin'
            : npc.role === 'shipwright' ? 'hammer'
              : npc.role === 'oracle' ? 'crystal'
                : npc.role === 'mysterious_stranger' ? 'hood' : '';
          if (!nkind) continue;
          this.drawPoiIcon(ctx, nkind, centerX + npc.position.x * scale, centerY + npc.position.z * scale, 5.5);
        }
        for (const cave of island.caves ?? []) {
          // Only ENTRANCES are chartable POIs — interior galleries are hidden
          // segments, and drawing all of them stamped a dozen cave icons per
          // mountain across the map.
          if (!cave.hasMouth) continue;
          this.drawPoiIcon(ctx, 'cave', centerX + cave.position.x * scale, centerY + cave.position.z * scale, 5.5);
        }
        // Name label above the isle, outlined for legibility over any tint.
        ctx.textBaseline = 'bottom';
        ctx.font = '600 13px Georgia, serif';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(6, 14, 26, 0.9)';
        ctx.strokeText(island.name, ix, iy - rPx - 4);
        ctx.fillStyle = '#f4e8c6';
        ctx.fillText(island.name, ix, iy - rPx - 4);
      }
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = fullscreen ? 'rgba(95, 91, 82, 0.92)' : 'rgba(95, 91, 82, 0.86)';
    ctx.strokeStyle = fullscreen ? 'rgba(235, 228, 204, 0.44)' : 'rgba(235, 228, 204, 0.36)';
    ctx.lineWidth = fullscreen ? 1.5 : 1;
    for (const rock of this.view.state.seaRocks ?? []) {
      const x = centerX + rock.position.x * scale;
      const y = centerY + rock.position.z * scale;
      const r = Math.max(fullscreen ? 4 : 2.5, rock.radius * scale);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    const closestHoarder = fullscreen && localPlayer ? this.view.getClosestGoldHoarder(localPlayer) : null;
    if (fullscreen && localPlayer && closestHoarder && (localPlayer.treasureMapIslandId || localPlayer.carryingChestId)) {
      const hx = centerX + closestHoarder.npc.position.x * scale;
      const hy = centerY + closestHoarder.npc.position.z * scale;
      const px = centerX + localX * scale;
      const py = centerY + localZ * scale;
      ctx.save();
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = 'rgba(240, 198, 90, 0.72)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0c65a';
      ctx.strokeStyle = 'rgba(42, 24, 7, 0.92)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2b1a08';
      ctx.font = '700 8px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GH', hx, hy + 0.2);
      ctx.fillStyle = '#f5dfa7';
      ctx.font = '600 12px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`Gold Hoarder - ${closestHoarder.island.name}`, hx + 11, hy - 8);
      ctx.restore();
    }

    if (fullscreen) {
      const mappedIsland = localPlayer?.treasureMapIslandId
        ? this.view.state.islands.find((island) => island.id === localPlayer.treasureMapIslandId) ?? null
        : null;
      const chart = mappedIsland ?? this.view.getNearestIsland(localX, localZ);
      const hasGoldMap = !!mappedIsland;
      if (chart) {
        const inset = 128;
        const ix = width - inset - 26;
        const iy = height - inset - 26;
        ctx.fillStyle = 'rgba(18, 12, 6, 0.9)';
        ctx.fillRect(ix, iy, inset, inset);
        ctx.strokeStyle = 'rgba(201, 168, 76, 0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(ix, iy, inset, inset);
        ctx.fillStyle = '#e8d5a3';
        ctx.font = '600 11px Georgia, serif';
        ctx.fillText(chart.name, ix + 8, iy + 16);
        ctx.fillStyle = 'rgba(200, 190, 168, 0.72)';
        ctx.font = '9px Georgia, serif';
        ctx.fillText(hasGoldMap ? 'Gold Hoarder chart' : 'No treasure chart yet', ix + 8, iy + 30);
        const cx = ix + inset * 0.5;
        const cy = iy + inset * 0.54;
        ctx.fillStyle = 'rgba(110, 86, 56, 0.55)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, inset * 0.36, inset * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(201, 168, 76, 0.4)';
        ctx.stroke();
        for (const c of hasGoldMap ? this.getTreasureChartChests(chart) : []) {
          if (c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating) continue;
          const mx = cx + c.mapOffsetX * inset * 0.3;
          const my = cy + c.mapOffsetZ * inset * 0.3;
          this.drawTreasureX(ctx, mx, my, 8, '#7a1515');
        }
      }
    }

    for (const ship of this.view.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      const isOwn = ship.id === trackedShip?.id;
      this.drawShipMarker(
        ctx,
        centerX + ship.position.x * scale,
        centerY + ship.position.z * scale,
        ship.rotation,
        fullscreen ? 12 : 7.5,
        isOwn ? '#7fd4ff' : '#ff8f70',
        isOwn ? 'rgba(12, 40, 60, 0.62)' : 'rgba(43, 12, 8, 0.55)',
      );
    }

    this.drawShipMarker(
      ctx,
      centerX + localX * scale,
      centerY + localZ * scale,
      localHeading,
      fullscreen ? 15 : 9,
      '#ffffff',
      'rgba(55, 164, 235, 0.92)',
    );

    ctx.save();
    ctx.translate(centerX + localX * scale, centerY + localZ * scale);
    ctx.rotate(Math.PI - localHeading);
    ctx.fillStyle = fullscreen ? 'rgba(103, 197, 255, 0.18)' : 'rgba(103, 197, 255, 0.14)';
    const coneTip = fullscreen ? 28 : 18;
    const coneBaseX = fullscreen ? 14 : 9;
    const coneBaseY = fullscreen ? 8 : 5;
    ctx.beginPath();
    ctx.moveTo(0, -coneTip);
    ctx.lineTo(coneBaseX, coneBaseY);
    ctx.lineTo(-coneBaseX, coneBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawShipMarker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rotation: number,
    size: number,
    fill: string,
    stroke: string,
  ) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - rotation);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.72, size * 0.65);
    ctx.lineTo(0, size * 0.34);
    ctx.lineTo(-size * 0.72, size * 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Rasterize an island's TRUE above-water land shape (once, cached). Sampling
   *  getIslandSurfaceY over the footprint means archipelagos draw as separate
   *  islets, crescents as a C around their bay, twins with their saddle — instead
   *  of the old single smooth footprint-ring blob. */
  private getIslandChartBitmap(island: Island): { canvas: HTMLCanvasElement; extent: number } {
    const cached = this.islandChartCache.get(island.id);
    if (cached) return cached;
    const extent = getIslandMaxRadius(island) * 1.04;
    const gridN = THREE.MathUtils.clamp(Math.round(extent / 1.4), 48, 150);
    const canvas = document.createElement('canvas');
    canvas.width = gridN;
    canvas.height = gridN;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(gridN, gridN);
    const data = img.data;
    const palette = island.profile.palette
      ?? BIOME_PALETTES[island.profile.biome ?? 'lush'] ?? BIOME_PALETTES.lush;
    const sand = new THREE.Color(palette.sand);
    const grass = new THREE.Color(palette.grass);
    const rock = new THREE.Color(palette.rock);
    const isVolcanic = (island.profile.biome ?? 'lush') === 'volcanic';
    const ash = new THREE.Color(0x2b2621);
    const col = new THREE.Color();
    for (let gz = 0; gz < gridN; gz++) {
      for (let gx = 0; gx < gridN; gx++) {
        const lx = ((gx + 0.5) / gridN * 2 - 1) * extent;
        const lz = ((gz + 0.5) / gridN * 2 - 1) * extent;
        const y = getIslandSurfaceY(island, island.position.x + lx, island.position.z + lz);
        const idx = (gz * gridN + gx) * 4;
        if (y <= 0.35) { data[idx + 3] = 0; continue; }   // below the waterline → sea shows through
        const t = THREE.MathUtils.clamp((y - 0.35) / 3.0, 0, 1); // shore sand → interior grass
        col.copy(sand).lerp(grass, t);
        if (y > 7) col.lerp(rock, THREE.MathUtils.clamp((y - 7) / 15, 0, 0.65));   // rocky heights
        if (isVolcanic && y > 6) col.lerp(ash, THREE.MathUtils.clamp((y - 6) / 12, 0, 0.7));
        data[idx] = Math.round(col.r * 255);
        data[idx + 1] = Math.round(col.g * 255);
        data[idx + 2] = Math.round(col.b * 255);
        data[idx + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const entry = { canvas, extent };
    this.islandChartCache.set(island.id, entry);
    return entry;
  }

  private drawIslandChart(
    ctx: CanvasRenderingContext2D,
    island: Island,
    centerX: number,
    centerY: number,
    scale: number,
    fullscreen: boolean,
  ) {
    // Draw the island's TRUE above-water shape from a cached land-mask bitmap
    // (archipelago islets separate, crescent bays open, twin saddles) instead of
    // a single smooth footprint ring.
    const bmp = this.getIslandChartBitmap(island);
    const size = bmp.extent * 2 * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      bmp.canvas,
      centerX + (island.position.x - bmp.extent) * scale,
      centerY + (island.position.z - bmp.extent) * scale,
      size,
      size,
    );
    ctx.restore();

    if (island.dock) {
      const dock = island.dock;
      const dx = centerX + dock.position.x * scale;
      const dy = centerY + dock.position.z * scale;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(Math.PI - dock.rotation);
      ctx.fillStyle = fullscreen ? 'rgba(124, 82, 42, 0.95)' : 'rgba(124, 82, 42, 0.82)';
      ctx.fillRect(
        -Math.max(1.5, dock.width * scale * 0.5),
        -Math.max(4, dock.length * scale * 0.5),
        Math.max(3, dock.width * scale),
        Math.max(8, dock.length * scale),
      );
      ctx.restore();
    }

    for (const station of island.upgradeStations) {
      const claimed = station.claimedByShipId !== null;
      const sx = centerX + station.position.x * scale;
      const sy = centerY + station.position.z * scale;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI * 0.25);
      ctx.fillStyle = claimed ? 'rgba(120, 126, 138, 0.7)' : 'rgba(246, 194, 86, 0.95)';
      const size = fullscreen ? 4.5 : 2.6;
      ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
      ctx.restore();
    }

    if (fullscreen) {
      for (const npc of island.npcs ?? []) {
        const nx = centerX + npc.position.x * scale;
        const ny = centerY + npc.position.z * scale;
        if (npc.role === 'gold_hoarder') {
          ctx.fillStyle = '#f0c65a';
          ctx.strokeStyle = 'rgba(41, 29, 12, 0.92)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(nx, ny, 4.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#2b1a08';
          ctx.font = '700 6px Georgia, serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('GH', nx, ny + 0.2);
        } else {
          ctx.fillStyle = 'rgba(235, 221, 169, 0.95)';
          ctx.strokeStyle = 'rgba(41, 29, 12, 0.78)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(nx, ny, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }
}
