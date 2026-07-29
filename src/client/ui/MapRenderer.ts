/**
 * Draws every chart surface: the corner minimap, the fullscreen chart of the
 * Shattered Reach, the per-island treasure chart and the map-selection wheel.
 * Owns the map's own UI state (open flag, zoom, cached island bitmaps) and
 * reads the world through a narrow `MapView`.
 */
import * as THREE from 'three';
import { WORLD } from '../../shared/constants/index.js';
import type { GameState, Island, IslandNpc, Player, Ship, TreasureChest } from '../../shared/types/index.js';
import { getIslandMaxRadius, getIslandSurfaceY } from '../../shared/utils/index.js';
import { BIOME_PALETTES } from '../../shared/props.js';
import type { InputManager } from '../input/InputManager.js';
import type { Renderer } from '../rendering/Renderer.js';
import type { UiRefs } from './UiRefs.js';
import { BROKER_NAME } from './DisplayNames.js';

/** A rasterized island land-shape, halo baked in, ready to stamp on a chart. */
type ChartBitmap = {
  /** Padded canvas — the pale shoreline halo lives in the padding. */
  canvas: HTMLCanvasElement;
  /** World half-size the PADDED canvas covers (use this to place it). */
  extent: number;
  /** World half-size the raw sample grid covered. */
  coreExtent: number;
  /** Sample grid resolution (unpadded). */
  grid: number;
  /** grid×grid land mask dilated by 2 texels — lets the hi-res pass skip sea. */
  seaMask: Uint8Array;
};

/** A hi-res chart rasterization in flight, sampled a few rows per frame. */
type ChartLod = {
  extent: number;
  grid: number;
  /** Next grid row to sample. */
  row: number;
  heights: Float32Array;
  /** The base bitmap's land mask projected onto this grid. */
  mask: Uint8Array;
};

/** Fullscreen zoom past which the 512px chart LOD is worth rasterizing. */
const CHART_LOD_ZOOM = 2.5;
/** Milliseconds of island rasterization allowed per full-map frame. */
const CHART_LOD_BUDGET_MS = 4;
/** How many hi-res island charts to keep before evicting the oldest. */
const CHART_LOD_KEEP = 6;
/** Base island bitmaps rasterized per drawn frame. The whole Reach — fourteen
 *  islands, each a grid of surface samples — used to be rasterized on the ONE
 *  frame the minimap first drew, a hitch landing right on top of the join. Two
 *  a frame spreads it over a handful of frames on a map nobody is reading yet;
 *  an island with no bitmap yet simply waits its turn. */
const CHART_BASE_BUILDS_PER_FRAME = 2;
/** Banked gold under which a crew is still on its FIRST errand — well under one
 *  chest's sale, so kill bounties alone never clear it. Above it the pirate has
 *  demonstrably found the gold loop and the signpost stands down. */
const FIRST_GOLD_CEILING = 500;

export type MapView = {
  readonly ui: UiRefs;
  readonly input: InputManager;
  readonly renderer: Renderer;
  readonly state: GameState | null;
  /** True until the pirate first boards — highlights their own hull on the chart. */
  readonly ownShipBeaconActive: boolean;
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
  private readonly islandChartCache = new Map<string, ChartBitmap>();
  /** 256-512px rasterizations, built lazily once the chart is zoomed past
   *  CHART_LOD_ZOOM so the land stops being a blocky upscaled smear. */
  private readonly islandChartLodCache = new Map<string, ChartBitmap>();
  private readonly islandChartLodInFlight = new Map<string, ChartLod>();
  /** Base rasterizations spent on the frame being drawn (see the constant). */
  private chartBuildsThisFrame = 0;
  private treasureChartSignature = '';

  /** Where the fullscreen chart is centred, in world units. `null` follows the
   *  local pirate (the old behaviour); dragging or clicking a label pins it, so
   *  a distant island can actually be inspected. Reset every time the map opens. */
  private chartFocus: { x: number; z: number } | null = null;
  /** Label boxes from the last fullscreen draw — click targets for centring. */
  private labelHits: Array<{
    id: string; name: string; x: number; y: number; w: number; h: number; worldX: number; worldZ: number;
  }> = [];

  /** Called when the map opens: whole world, centred on the pirate again. */
  resetChartView() {
    this.mapZoom = 1;
    this.chartFocus = null;
  }

  /** Where the chart is looking right now (pan pin, or the pirate). */
  private currentChartFocus(): { x: number; z: number } {
    if (this.chartFocus) return this.chartFocus;
    const player = this.view.getLocalPlayer();
    const ship = this.view.getTrackedShip();
    return {
      x: player?.position.x ?? ship?.position.x ?? 0,
      z: player?.position.z ?? ship?.position.z ?? 0,
    };
  }

  /** Keep the visible window inside the Shattered Reach — you can pan to any
   *  corner of the world but never off it into empty navy. At 1× the whole world
   *  already fits, so this collapses to dead centre. */
  private clampChartFocus(focus: { x: number; z: number }, width: number, height: number, scale: number) {
    const limitX = Math.max(0, WORLD.HALF - width * 0.5 / scale);
    const limitZ = Math.max(0, WORLD.HALF - height * 0.5 / scale);
    return {
      x: THREE.MathUtils.clamp(focus.x, -limitX, limitX),
      z: THREE.MathUtils.clamp(focus.z, -limitZ, limitZ),
    };
  }

  /** Canvas pixels per CSS pixel, and the canvas-space scale, for the open map. */
  private chartMetrics() {
    const canvas = this.view.ui.mapCanvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      canvas,
      rect,
      pxPerClientX: canvas.width / rect.width,
      pxPerClientY: canvas.height / rect.height,
      scale: Math.min(canvas.width, canvas.height) / WORLD.SIZE * this.mapZoom,
    };
  }

  /** Drag-to-pan. Deltas are CSS pixels of pointer travel over the chart. */
  panByClient(dxClient: number, dyClient: number) {
    const m = this.chartMetrics();
    if (!m) return;
    const focus = this.currentChartFocus();
    this.chartFocus = this.clampChartFocus({
      x: focus.x - dxClient * m.pxPerClientX / m.scale,
      z: focus.z - dyClient * m.pxPerClientY / m.scale,
    }, m.canvas.width, m.canvas.height, m.scale);
  }

  /** Scroll-zoom that keeps the water under the cursor under the cursor, so you
   *  can pull a far island in just by pointing at it and scrolling. */
  zoomAtClient(factor: number, clientX: number, clientY: number) {
    const m = this.chartMetrics();
    const previousZoom = this.mapZoom;
    const nextZoom = THREE.MathUtils.clamp(previousZoom * factor, 1, 7);
    if (!m) { this.mapZoom = nextZoom; return; }
    const focus = this.clampChartFocus(this.currentChartFocus(), m.canvas.width, m.canvas.height, m.scale);
    const px = (clientX - m.rect.left) * m.pxPerClientX - m.canvas.width * 0.5;
    const py = (clientY - m.rect.top) * m.pxPerClientY - m.canvas.height * 0.5;
    const worldX = focus.x + px / m.scale;
    const worldZ = focus.z + py / m.scale;
    this.mapZoom = nextZoom;
    const nextScale = Math.min(m.canvas.width, m.canvas.height) / WORLD.SIZE * nextZoom;
    this.chartFocus = this.clampChartFocus({
      x: worldX - px / nextScale,
      z: worldZ - py / nextScale,
    }, m.canvas.width, m.canvas.height, nextScale);
  }

  /** Click an island (its name label or its land) to centre and open it up.
   *  Returns true when something was hit, so a plain click on open water can
   *  fall through to "nothing happened". */
  focusIslandAtClient(clientX: number, clientY: number): boolean {
    const m = this.chartMetrics();
    if (!m || !this.view.state) return false;
    const px = (clientX - m.rect.left) * m.pxPerClientX;
    const py = (clientY - m.rect.top) * m.pxPerClientY;
    let hit: { x: number; z: number } | null = null;
    for (const label of this.labelHits) {
      if (px >= label.x && px <= label.x + label.w && py >= label.y && py <= label.y + label.h) {
        hit = { x: label.worldX, z: label.worldZ };
        break;
      }
    }
    if (!hit) {
      const focus = this.clampChartFocus(this.currentChartFocus(), m.canvas.width, m.canvas.height, m.scale);
      const worldX = focus.x + (px - m.canvas.width * 0.5) / m.scale;
      const worldZ = focus.z + (py - m.canvas.height * 0.5) / m.scale;
      for (const island of this.view.state.islands) {
        const reach = getIslandMaxRadius(island) * 1.05;
        if (Math.hypot(island.position.x - worldX, island.position.z - worldZ) <= reach) {
          hit = { x: island.position.x, z: island.position.z };
          break;
        }
      }
    }
    if (!hit) return false;
    this.mapZoom = Math.max(this.mapZoom, 3.2);
    const nextScale = Math.min(m.canvas.width, m.canvas.height) / WORLD.SIZE * this.mapZoom;
    this.chartFocus = this.clampChartFocus(hit, m.canvas.width, m.canvas.height, nextScale);
    return true;
  }

  /** Probe hooks (scripts/map-chart-probe.mjs) — never called in play. */
  debugFocus() { return this.clampChartFocus(this.currentChartFocus(), this.view.ui.mapCanvas.width, this.view.ui.mapCanvas.height, Math.min(this.view.ui.mapCanvas.width, this.view.ui.mapCanvas.height) / WORLD.SIZE * this.mapZoom); }
  debugLabelHitTargets() { return this.labelHits.map((label) => ({ ...label, x: label.x + label.w * 0.5, y: label.y + label.h * 0.5 })); }
  debugChartBitmapSizes() {
    const sizes: Record<string, { base: number; lod: number | null }> = {};
    for (const [id, bmp] of this.islandChartCache) {
      sizes[id] = { base: bmp.grid, lod: this.islandChartLodCache.get(id)?.grid ?? null };
    }
    return sizes;
  }

  drawMaps() {
    if (!this.view.state) return;
    // One frame, one rasterization budget — the fullscreen pass below draws the
    // same islands and shares it rather than doubling it.
    this.chartBuildsThisFrame = 0;
    const minimapCtx = this.view.ui.minimapCanvas.getContext('2d');
    if (minimapCtx) {
      this.renderBattleMap(minimapCtx, this.view.ui.minimapCanvas.width, this.view.ui.minimapCanvas.height, false);
    }
    if (this.mapOpen) {
      this.drawGlyphKey();
      this.drawFullMap(true);
    }
  }

  /** The opened map redraws every frame while it's up, so your arrow and the
   *  other ships track live as you move/turn (the minimap stays throttled). */
  drawFullMap(shareFrameBudget = false) {
    if (!this.view.state || !this.mapOpen) return;
    this.drawGlyphKey();
    if (!shareFrameBudget) this.chartBuildsThisFrame = 0;
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
      empty.textContent = `No charts held — visit a ${BROKER_NAME} for a treasure map.`;
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
      ? `Return chest to the ${BROKER_NAME} at ${closestHoarder?.island.name ?? chartIsland.name}`
      : treasureMarks.length > 0
        ? `${treasureMarks.length} buried X mark${treasureMarks.length === 1 ? '' : 's'} | shovel in pocket`
        : `No buried marks left | return to ${closestHoarder?.island.name ?? BROKER_NAME}`;
    const islandText = mappedIsland ? `${BROKER_NAME}'s chart: ${chartIsland.name}` : `${BROKER_NAME} return`;
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

    const chartBitmap = this.getIslandChartBitmap(chartIsland);
    const cx = width * 0.5;
    const cy = height * 0.53;
    // Scale off the BITMAP's extent, not island.radius: the same land raster the
    // chart stamps, so the Tallyman's chart and the main map agree on what
    // this isle actually looks like (bays open, islets separate).
    const mapScale = Math.min(width, height) * 0.42 / chartBitmap.extent;
    const toMap = (x: number, z: number) => ({
      x: cx + (x - chartIsland.position.x) * mapScale,
      y: cy + (z - chartIsland.position.z) * mapScale,
    });

    ctx.save();
    this.stampChartBitmap(
      ctx,
      chartBitmap,
      chartIsland,
      cx - chartIsland.position.x * mapScale,
      cy - chartIsland.position.z * mapScale,
      mapScale,
    );

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

  /**
   * THE CHART'S GLYPH KEY.
   *
   * The battle map speaks a language of fourteen hand-drawn gold marks — a
   * mug, a coin, a hood, a trilithon, a set of ribs — and the game never once
   * said what any of them meant. A player could read "there is something at
   * that headland" and nothing more, which makes a chart a decoration.
   *
   * The key is drawn with the SAME drawPoiIcon the chart uses, so a mark in the
   * key is bit-identical to the mark on the water: no second set of art to
   * drift, no emoji stand-ins. It lives under the chart in the map overlay.
   */
  private static readonly GLYPH_KEY: ReadonlyArray<{ kind: string; label: string }> = [
    { kind: 'coin', label: 'Tallyman — sell chests' },
    { kind: 'mug', label: 'Tavern' },
    { kind: 'hammer', label: 'Shipwright / mine' },
    { kind: 'crystal', label: 'Oracle' },
    { kind: 'hood', label: 'Stranger / memorial' },
    { kind: 'cave', label: 'Cave mouth' },
    { kind: 'volcano', label: 'Volcano' },
    { kind: 'peak', label: 'Mountain' },
    { kind: 'fort', label: 'Fort / skull' },
    { kind: 'tower', label: 'Watchtower' },
    { kind: 'anchor', label: 'Shipwreck' },
    { kind: 'stones', label: 'Standing stones' },
    { kind: 'arch', label: 'Rock arch' },
    { kind: 'noose', label: 'Gallows' },
    { kind: 'ribs', label: 'Whale bones' },
    { kind: 'tentacle', label: "Kraken's kill" },
  ];

  /** Display width the key was last laid out for — a resized window relays it. */
  private glyphKeyWidth = 0;

  /**
   * Paint the key into #map-key-canvas.
   *
   * IT IS LAID OUT IN THE PIXELS A PLAYER ACTUALLY LOOKS AT. The first cut drew
   * 17 px type into a fixed 1800-wide backing store that CSS then squeezed into
   * a ~630 px band: every word landed on screen SIX PIXELS TALL. A key nobody
   * can read is the same as no key, which is the defect it was written to fix.
   * So the canvas is now sized from its own CSS box (times devicePixelRatio for
   * crispness), the layout is done in CSS pixels, and the type is 13 px — the
   * size the rest of the chart's furniture uses. It relays itself whenever that
   * box changes width.
   */
  drawGlyphKey(force = false): void {
    const canvas = document.getElementById('map-key-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    // Inside a display:none overlay the box measures 0. Unforced, that is not a
    // layout worth doing — wait for the frame where the chart is actually up.
    // Forced (the suites paint it cold), fall back to what the CSS will give it.
    const measured = Math.round(canvas.clientWidth);
    if (measured <= 240 && !force) return;
    const cssW = measured > 240
      ? measured
      : Math.round(Math.min(window.innerWidth * 0.86, window.innerHeight * 0.72, 900)) - 20;
    if (!force && this.glyphKeyWidth === cssW) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Only a REAL measurement is remembered, so a cold forced paint relays the
    // moment the overlay opens for true.
    this.glyphKeyWidth = measured > 240 ? cssW : 0;

    const entries = MapRenderer.GLYPH_KEY;
    // Four columns need ~165 px each for the longest label at 13 px Georgia.
    const cols = cssW >= 660 ? 4 : cssW >= 430 ? 3 : 2;
    const rows = Math.ceil(entries.length / cols);
    // Short windows get a tighter band so the chart above it still fits.
    const vh = window.innerHeight;
    const tight = vh < 760;
    const fontPx = vh < 680 ? 10.5 : tight ? 11.5 : 13;
    const rowH = vh < 680 ? 16 : tight ? 18 : 21;
    const padX = 14;
    const headY = tight ? 12 : 14;
    const gridTop = headY + (tight ? 13 : 15);
    const footY = gridTop + rows * rowH + (tight ? 12 : 15);
    const cssH = Math.ceil(footY + (tight ? 12 : 14));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cellW = (cssW - padX * 2) / cols;
    const iconR = tight ? 6 : 7;

    ctx.fillStyle = '#c9a84c';
    ctx.font = `700 ${fontPx}px Georgia, serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('CHART MARKS', padX, headY);

    // EVERY MARK SITS ON A SCRAP OF LAND. Six of the sixteen glyphs — the
    // shipwreck, the arch, the gallows, the whale ribs, the kraken, the cave —
    // are drawn in the chart's near-black INK, which is how they read against a
    // green isle and how they vanish completely against a navy panel. Half the
    // key was blank labels. So each glyph is painted on the same sand-rimmed
    // green disc the chart puts under it out on the water: the mark in the key
    // is now the mark on the map, in its own habitat.
    const landChip = (cx: number, cy: number) => {
      ctx.save();
      ctx.fillStyle = '#e8d5a3';
      ctx.beginPath();
      ctx.arc(cx, cy, iconR + 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5fa84c';
      ctx.beginPath();
      ctx.arc(cx, cy, iconR + 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    entries.forEach((entry, i) => {
      const cx = padX + (i % cols) * cellW + iconR + 5;
      const cy = gridTop + Math.floor(i / cols) * rowH + rowH * 0.5;
      landChip(cx, cy);
      this.drawPoiIcon(ctx, entry.kind, cx, cy, iconR);
      ctx.fillStyle = '#d8cbaa';
      ctx.font = `400 ${fontPx}px Georgia, serif`;
      ctx.fillText(entry.label, cx + iconR + 10, cy + 1);
    });

    // A hairline, then the two marks that are not POI glyphs but ARE the
    // chart's whole point: where treasure is buried, and where it turns to gold.
    ctx.strokeStyle = 'rgba(201, 168, 76, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, footY - rowH * 0.62);
    ctx.lineTo(cssW - padX, footY - rowH * 0.62);
    ctx.stroke();

    ctx.font = `400 ${fontPx}px Georgia, serif`;
    const buried = 'Buried chest (your treasure chart)';
    const buriedX = padX + iconR + 5;
    const buriedTextX = buriedX + iconR + 10;
    landChip(buriedX, footY);
    this.drawTreasureX(ctx, buriedX, footY, iconR + 1, '#c02222');
    ctx.fillStyle = '#d8cbaa';
    ctx.fillText(buried, buriedTextX, footY + 1);
    // Measured, not assumed: at three columns a fixed cell offset dropped the
    // gold coin straight on top of the word "chart".
    const goldX = Math.max(
      padX + cellW * (cols >= 4 ? 2 : 1) + iconR + 5,
      buriedTextX + ctx.measureText(buried).width + iconR + 22,
    );
    landChip(goldX, footY);
    ctx.fillStyle = '#f0c65a';
    ctx.strokeStyle = 'rgba(42, 24, 7, 0.92)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(goldX, footY, iconR - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d8cbaa';
    ctx.fillText('Where your gold is sold', goldX + iconR + 10, footY + 1);
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
    // The opened chart looks at its focus point — the pirate by default, or
    // wherever they dragged/clicked to. The clamp keeps the window inside the
    // world, which at 1× collapses to dead centre (the old whole-world fit).
    const focus = fullscreen
      ? this.clampChartFocus(this.currentChartFocus(), width, height, scale)
      : { x: 0, z: 0 };
    const focusX = focus.x;
    const focusZ = focus.z;
    if (fullscreen && zoom > CHART_LOD_ZOOM) this.advanceChartLods(width, height, scale, focusX, focusZ);
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

    // Storm countdown chip — minimap only. On the fullscreen map the HTML title
    // sits in this same corner and the countdown is already the panel subtitle,
    // so drawing the chip here just smeared over the title.
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
      const labelPlan: Array<{ island: Island; ix: number; iy: number; rPx: number }> = [];
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
        // Name labels are laid out in a second pass below — collected here so
        // they can be nudged clear of each other and of the storm ring.
        labelPlan.push({ island, ix, iy, rPx });
      }
      this.drawIslandLabels(ctx, labelPlan, stormX, stormY, stormRadius);
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

    const closestHoarder = localPlayer ? this.view.getClosestGoldHoarder(localPlayer) : null;

    // ── FIRST GOLD ──────────────────────────────────────────────────────────
    // The opening objective told a new pirate to "sell treasure" in WORDS, on a
    // strip of text, while the chart in front of them carried no clue where
    // that could possibly happen. Until a crew has begun the gold loop — no
    // chart in hand, nothing in their arms, nothing meaningful banked — the
    // nearest Tallyman wears a small gold mark on BOTH charts. It goes away the
    // moment they have an errand of their own, and never comes back.
    if (
      localPlayer && closestHoarder
      && !localPlayer.treasureMapIslandId
      && !localPlayer.carryingChestId
      && (localPlayer.questMaps?.length ?? 0) === 0
      && localPlayer.gold < FIRST_GOLD_CEILING
    ) {
      const gx = centerX + closestHoarder.npc.position.x * scale;
      const gy = centerY + closestHoarder.npc.position.z * scale;
      // The pulse BREATHES, it does not blink. At a 0.3 alpha floor the ring
      // composited down to nothing against the chart's dark water for a third
      // of every cycle — a pirate glancing at the map in the wrong half-second
      // saw no signpost at all, which is the exact defect this mark exists to
      // fix. The floor is now high enough that the ring is always legible and
      // the swing is what draws the eye.
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 420);
      const r = (fullscreen ? 13 : 8) + pulse * (fullscreen ? 2 : 1.4);
      ctx.save();
      ctx.strokeStyle = `rgba(240, 198, 90, ${0.55 + pulse * 0.35})`;
      ctx.lineWidth = fullscreen ? 2.4 : 1.6;
      ctx.beginPath();
      ctx.arc(gx, gy, r, 0, Math.PI * 2);
      ctx.stroke();
      this.drawPoiIcon(ctx, 'coin', gx, gy, fullscreen ? 7 : 5);
      if (fullscreen) {
        ctx.fillStyle = '#f5dfa7';
        ctx.font = '700 12px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(`FIRST GOLD · ${closestHoarder.island.name}`, gx, gy - r - 7);
      }
      ctx.restore();
    }

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
      ctx.fillText(`${BROKER_NAME} — ${closestHoarder.island.name}`, hx + 11, hy - 8);
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
        ctx.fillText(hasGoldMap ? `${BROKER_NAME}'s chart` : 'No treasure chart yet', ix + 8, iy + 30);
        // The SAME land bitmap the main chart draws — the inset used to invent a
        // generic ellipse, which contradicted the honest shape three inches away.
        const cx = ix + inset * 0.5;
        const cy = iy + inset * 0.56;
        const bmp = this.getIslandChartBitmap(chart);
        const insetScale = inset * 0.38 / bmp.extent;
        this.stampChartBitmap(
          ctx,
          bmp,
          chart,
          cx - chart.position.x * insetScale,
          cy - chart.position.z * insetScale,
          insetScale,
        );
        // X marks land by true world projection, not a decorative offset.
        for (const c of hasGoldMap ? this.getTreasureChartChests(chart) : []) {
          if (c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating) continue;
          const mx = cx + (c.position.x - chart.position.x) * insetScale;
          const my = cy + (c.position.z - chart.position.z) * insetScale;
          this.drawTreasureX(ctx, mx, my, 8, '#c02222');
        }
      }
    }

    // ── THE GILDED WRECK ────────────────────────────────────────────────────
    // The whole point of the event is that EVERY crew learns about it in the
    // same second, so her mark is the loudest thing on the chart: a gold cross
    // in a pulsing double ring, sat on the next ring's centre.
    const gildedWreck = this.view.state.wreck;
    if (gildedWreck) {
      const wx = centerX + gildedWreck.position.x * scale;
      const wy = centerY + gildedWreck.position.z * scale;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 340);
      const r = (fullscreen ? 15 : 9) + pulse * (fullscreen ? 8 : 4.5);
      ctx.save();
      ctx.strokeStyle = `rgba(240, 194, 87, ${0.35 + pulse * 0.5})`;
      ctx.lineWidth = fullscreen ? 3 : 2;
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(wx, wy, r * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      // A wreck mark is a cross, not a dot — it has to read at minimap size.
      ctx.strokeStyle = '#ffe6a8';
      ctx.lineWidth = fullscreen ? 3.4 : 2.2;
      const arm = fullscreen ? 8 : 5;
      ctx.beginPath();
      ctx.moveTo(wx - arm, wy - arm); ctx.lineTo(wx + arm, wy + arm);
      ctx.moveTo(wx + arm, wy - arm); ctx.lineTo(wx - arm, wy + arm);
      ctx.stroke();
      if (fullscreen) {
        ctx.fillStyle = '#f5dfa7';
        ctx.font = '700 13px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('THE GILDED WRECK', wx, wy - r - 8);
      }
      ctx.restore();
    }

    for (const ship of this.view.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      const isOwn = ship.id === trackedShip?.id;
      // Until the pirate boards for the first time, their own hull wears a
      // pulsing gold ring — "that one, over there, is yours".
      if (isOwn && this.view.ownShipBeaconActive) {
        const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 260);
        const ringR = (fullscreen ? 26 : 15) + pulse * (fullscreen ? 6 : 3.5);
        ctx.save();
        ctx.strokeStyle = `rgba(255, 208, 110, ${0.45 + pulse * 0.45})`;
        ctx.lineWidth = fullscreen ? 3 : 2;
        ctx.beginPath();
        ctx.arc(centerX + ship.position.x * scale, centerY + ship.position.z * scale, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // BOUNTY PING. A crew past 60% of the gold target is the match's prize,
      // and until now that was invisible: the leader was a number on a
      // scoreboard nobody could point at. Their hull now wears the same
      // pulsing ring the game uses to say "that one, over there" about your own
      // ship — in hunter's amber — on every chart in the fleet.
      if (ship.bountied) {
        const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 300 + ship.position.x);
        const baseR = fullscreen ? 22 : 13;
        ctx.save();
        ctx.strokeStyle = `rgba(255, 152, 66, ${0.4 + pulse * 0.5})`;
        ctx.lineWidth = fullscreen ? 2.6 : 1.8;
        ctx.beginPath();
        ctx.arc(
          centerX + ship.position.x * scale,
          centerY + ship.position.z * scale,
          baseR + pulse * (fullscreen ? 7 : 4),
          0, Math.PI * 2,
        );
        ctx.stroke();
        // Crossed-swords tick marks so the ring reads as a HUNT, not a beacon.
        ctx.strokeStyle = `rgba(255, 205, 130, ${0.5 + pulse * 0.4})`;
        ctx.lineWidth = fullscreen ? 2 : 1.4;
        for (let k = 0; k < 4; k += 1) {
          const a = (k / 4) * Math.PI * 2 + Math.PI * 0.25;
          const cx0 = centerX + ship.position.x * scale;
          const cy0 = centerY + ship.position.z * scale;
          ctx.beginPath();
          ctx.moveTo(cx0 + Math.cos(a) * (baseR + 2), cy0 + Math.sin(a) * (baseR + 2));
          ctx.lineTo(cx0 + Math.cos(a) * (baseR + (fullscreen ? 9 : 6)), cy0 + Math.sin(a) * (baseR + (fullscreen ? 9 : 6)));
          ctx.stroke();
        }
        ctx.restore();
      }
      this.drawShipMarker(
        ctx,
        centerX + ship.position.x * scale,
        centerY + ship.position.z * scale,
        ship.rotation,
        fullscreen ? 12 : 7.5,
        ship.bountied ? '#ffb347' : isOwn ? '#7fd4ff' : '#ff8f70',
        ship.bountied ? 'rgba(70, 30, 4, 0.7)' : isOwn ? 'rgba(12, 40, 60, 0.62)' : 'rgba(43, 12, 8, 0.55)',
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

  /**
   * Second label pass: measure every island name, then nudge the boxes until
   * none of them overlap another and none of them straddle the storm ring
   * (where white-on-purple made 'Kraken Tooth' unreadable). A label that had to
   * travel gets a hairline leader back to its isle so it stays attributable.
   * The final boxes double as click targets for centring the chart.
   */
  private drawIslandLabels(
    ctx: CanvasRenderingContext2D,
    plan: Array<{ island: Island; ix: number; iy: number; rPx: number }>,
    stormX: number,
    stormY: number,
    stormRadius: number,
  ) {
    ctx.font = '600 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const lineHeight = 15;
    const gap = 3;
    const ringBand = lineHeight * 1.15 + 5;
    // Push a label's baseline off the storm ring along the shortest vertical
    // move — the ring is a circle, so the exits are its two y-intercepts here.
    const clearOfRing = (x: number, y: number) => {
      const dx = x - stormX;
      const midY = y - lineHeight * 0.5;
      const distance = Math.hypot(dx, midY - stormY);
      if (distance < stormRadius - ringBand || distance > stormRadius + ringBand) return y;
      let best = y;
      let bestTravel = Infinity;
      for (const radius of [stormRadius - ringBand, stormRadius + ringBand]) {
        const square = radius * radius - dx * dx;
        if (square <= 0) continue;
        const root = Math.sqrt(square);
        for (const candidate of [stormY + root, stormY - root]) {
          const travel = Math.abs(candidate + lineHeight * 0.5 - y);
          if (travel < bestTravel) { bestTravel = travel; best = candidate + lineHeight * 0.5; }
        }
      }
      return bestTravel === Infinity ? y : best;
    };

    const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    this.labelHits = [];
    const entries = plan
      .map((entry) => ({ ...entry, w: ctx.measureText(entry.island.name).width + 8, y: entry.iy - entry.rPx - 4 }))
      .sort((a, b) => a.y - b.y);
    for (const entry of entries) {
      const left = entry.ix - entry.w * 0.5;
      const right = entry.ix + entry.w * 0.5;
      let y = clearOfRing(entry.ix, entry.y);
      for (let pass = 0; pass < 20; pass++) {
        let moved = false;
        for (const box of placed) {
          if (right < box.left || left > box.right) continue;
          if (y <= box.top || y - lineHeight >= box.bottom) continue;
          y = box.top - gap;                 // stack upward, away from the isle
          moved = true;
        }
        const cleared = clearOfRing(entry.ix, y);
        if (cleared !== y) { y = cleared; moved = true; }
        if (!moved) break;
      }
      placed.push({ left, right, top: y - lineHeight, bottom: y });
      const travelled = Math.abs(y - entry.y);
      if (travelled > 7) {
        ctx.save();
        ctx.strokeStyle = 'rgba(244, 232, 198, 0.34)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(entry.ix, y + 1);
        ctx.lineTo(entry.ix, entry.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(6, 14, 26, 0.9)';
      ctx.strokeText(entry.island.name, entry.ix, y);
      ctx.fillStyle = '#f4e8c6';
      ctx.fillText(entry.island.name, entry.ix, y);
      this.labelHits.push({
        id: entry.island.id,
        name: entry.island.name,
        x: left,
        y: y - lineHeight,
        w: entry.w,
        h: lineHeight,
        worldX: entry.island.position.x,
        worldZ: entry.island.position.z,
      });
    }
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
  private getIslandChartBitmap(island: Island): ChartBitmap {
    const cached = this.islandChartCache.get(island.id);
    if (cached) return cached;
    const extent = getIslandMaxRadius(island) * 1.04;
    const grid = THREE.MathUtils.clamp(Math.round(extent / 1.4), 48, 150);
    const heights = new Float32Array(grid * grid);
    this.sampleChartRows(island, grid, extent, heights, 0, grid, null);
    const entry = this.composeChartBitmap(
      grid,
      extent,
      this.shadeChartPixels(island, grid, extent, heights, false),
      this.buildDilatedMask(grid, heights),
    );
    this.islandChartCache.set(island.id, entry);
    return entry;
  }

  /** Sample the true surface height over one band of an island's chart grid. */
  private sampleChartRows(
    island: Island,
    grid: number,
    extent: number,
    heights: Float32Array,
    fromRow: number,
    toRow: number,
    seaMask: Uint8Array | null,
  ) {
    for (let gz = fromRow; gz < toRow; gz++) {
      for (let gx = 0; gx < grid; gx++) {
        const index = gz * grid + gx;
        // The hi-res pass reuses the base bitmap's dilated land mask to skip the
        // open sea inside the bounding square — roughly half the samples, and
        // every one of them is a full fbm terrain evaluation.
        if (seaMask && seaMask[index] === 0) { heights[index] = -9; continue; }
        const lx = ((gx + 0.5) / grid * 2 - 1) * extent;
        const lz = ((gz + 0.5) / grid * 2 - 1) * extent;
        heights[index] = getIslandSurfaceY(island, island.position.x + lx, island.position.z + lz);
      }
    }
  }

  /** Land mask (1 = above water) grown by 2 texels, so a coarse grid can vouch
   *  for a finer one without ever clipping the real coastline. */
  private buildDilatedMask(grid: number, heights: Float32Array): Uint8Array {
    const raw = new Uint8Array(grid * grid);
    for (let i = 0; i < raw.length; i++) raw[i] = heights[i] > 0.35 ? 1 : 0;
    const horizontal = new Uint8Array(grid * grid);
    for (let gz = 0; gz < grid; gz++) {
      for (let gx = 0; gx < grid; gx++) {
        let hit = 0;
        for (let d = -2; d <= 2 && hit === 0; d++) {
          const sx = gx + d;
          if (sx >= 0 && sx < grid && raw[gz * grid + sx] === 1) hit = 1;
        }
        horizontal[gz * grid + gx] = hit;
      }
    }
    const out = new Uint8Array(grid * grid);
    for (let gz = 0; gz < grid; gz++) {
      for (let gx = 0; gx < grid; gx++) {
        let hit = 0;
        for (let d = -2; d <= 2 && hit === 0; d++) {
          const sz = gz + d;
          if (sz >= 0 && sz < grid && horizontal[sz * grid + gx] === 1) hit = 1;
        }
        out[gz * grid + gx] = hit;
      }
    }
    return out;
  }

  /** Turn a sampled height field into chart pixels: biome colour, a north-west
   *  hillshade so relief reads at a glance, a wet-sand rim, and — on the hi-res
   *  LOD — contour rings every few metres, so zooming in genuinely reveals the
   *  shape of the land instead of magnifying a blob. */
  private shadeChartPixels(
    island: Island,
    grid: number,
    extent: number,
    heights: Float32Array,
    contours: boolean,
  ): Uint8ClampedArray {
    const data = new Uint8ClampedArray(grid * grid * 4);
    const palette = island.profile.palette
      ?? BIOME_PALETTES[island.profile.biome ?? 'lush'] ?? BIOME_PALETTES.lush;
    const sand = new THREE.Color(palette.sand);
    const grass = new THREE.Color(palette.grass);
    const rock = new THREE.Color(palette.rock);
    const isVolcanic = (island.profile.biome ?? 'lush') === 'volcanic';
    // Cooled basalt, not soot: the old near-black ash sank volcanic isles into
    // the navy ocean. This still reads burnt, but survives deep water under it.
    const ash = new THREE.Color(0x5d5147);
    const shore = new THREE.Color(0xf0e2bd);
    const col = new THREE.Color();
    let maxHeight = 0;
    for (let i = 0; i < heights.length; i++) if (heights[i] > maxHeight) maxHeight = heights[i];
    const contourStep = Math.max(2.5, maxHeight / 9);
    const cell = 2 * extent / grid;
    const at = (gx: number, gz: number) => {
      const cx = gx < 0 ? 0 : gx >= grid ? grid - 1 : gx;
      const cz = gz < 0 ? 0 : gz >= grid ? grid - 1 : gz;
      const h = heights[cz * grid + cx];
      return h > 0 ? h : 0;
    };
    for (let gz = 0; gz < grid; gz++) {
      for (let gx = 0; gx < grid; gx++) {
        const index = gz * grid + gx;
        const y = heights[index];
        const idx = index * 4;
        if (y <= 0.35) { data[idx + 3] = 0; continue; }   // below the waterline → sea shows through
        const t = THREE.MathUtils.clamp((y - 0.35) / 3.0, 0, 1); // shore sand → interior grass
        col.copy(sand).lerp(grass, t);
        if (y > 7) col.lerp(rock, THREE.MathUtils.clamp((y - 7) / 15, 0, 0.65));   // rocky heights
        if (isVolcanic && y > 6) col.lerp(ash, THREE.MathUtils.clamp((y - 6) / 12, 0, 0.62));
        // Hillshade straight off the sampled gradient, light from the north-west.
        const dhdx = (at(gx + 1, gz) - at(gx - 1, gz)) / (2 * cell);
        const dhdz = (at(gx, gz + 1) - at(gx, gz - 1)) / (2 * cell);
        const inv = 1 / Math.sqrt(dhdx * dhdx + dhdz * dhdz + 1);
        const lambert = (dhdx * 0.5345 + dhdz * 0.5345 + 0.6547) * inv;
        col.multiplyScalar(THREE.MathUtils.clamp(0.66 + lambert * 0.48, 0.7, 1.24));
        // Wet-sand rim — the shoreline stays the brightest line on the island.
        if (y < 1.2) col.lerp(shore, (1.2 - y) / 1.2 * 0.42);
        if (contours && y > 1.4) {
          const band = Math.floor(y / contourStep);
          if (band !== Math.floor(at(gx - 1, gz) / contourStep) || band !== Math.floor(at(gx, gz - 1) / contourStep)) {
            col.multiplyScalar(0.74);
          }
        }
        data[idx] = Math.round(THREE.MathUtils.clamp(col.r, 0, 1) * 255);
        data[idx + 1] = Math.round(THREE.MathUtils.clamp(col.g, 0, 1) * 255);
        data[idx + 2] = Math.round(THREE.MathUtils.clamp(col.b, 0, 1) * 255);
        data[idx + 3] = 255;
      }
    }
    return data;
  }

  /** Bake the pixels onto a padded canvas with a pale shoreline halo, so every
   *  island — a volcanic cone included — separates from navy water without
   *  costing a blur on every single frame. */
  private composeChartBitmap(
    grid: number,
    extent: number,
    data: Uint8ClampedArray,
    seaMask: Uint8Array,
  ): ChartBitmap {
    const source = document.createElement('canvas');
    source.width = grid;
    source.height = grid;
    const sourceCtx = source.getContext('2d')!;
    const image = sourceCtx.createImageData(grid, grid);
    image.data.set(data);
    sourceCtx.putImageData(image, 0, 0);
    const pad = Math.max(2, Math.round(grid * 0.05));
    const padded = grid + pad * 2;
    const canvas = document.createElement('canvas');
    canvas.width = padded;
    canvas.height = padded;
    const g = canvas.getContext('2d')!;
    g.shadowColor = 'rgba(176, 214, 250, 0.62)';
    g.shadowBlur = pad * 0.85;
    g.drawImage(source, pad, pad);
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
    g.drawImage(source, pad, pad);
    return { canvas, extent: extent * padded / grid, coreExtent: extent, grid, seaMask };
  }

  /** Best chart bitmap available at this zoom — the sharp LOD once it exists,
   *  the base one meanwhile, so the chart never blanks while it sharpens.
   *  Null means "not rasterized yet and this frame's budget is spent": the
   *  island is skipped and drawn on one of the next few frames instead. */
  private pickChartBitmap(island: Island, zoom: number): ChartBitmap | null {
    if (zoom > CHART_LOD_ZOOM) {
      const lod = this.islandChartLodCache.get(island.id);
      if (lod) return lod;
    }
    const cached = this.islandChartCache.get(island.id);
    if (cached) return cached;
    if (this.chartBuildsThisFrame >= CHART_BASE_BUILDS_PER_FRAME) return null;
    this.chartBuildsThisFrame += 1;
    return this.getIslandChartBitmap(island);
  }

  /** A full 512px island is ~250k terrain evaluations — far too much for one
   *  frame. Spend a few milliseconds per frame on the islands actually on
   *  screen, nearest first, and swap the sharp bitmap in when it finishes. */
  private advanceChartLods(width: number, height: number, scale: number, focusX: number, focusZ: number) {
    if (!this.view.state) return;
    const halfW = width * 0.5 / scale;
    const halfH = height * 0.5 / scale;
    const pending = this.view.state.islands
      .filter((island) => !this.islandChartLodCache.has(island.id))
      .filter((island) => {
        const reach = getIslandMaxRadius(island) * 1.2;
        return Math.abs(island.position.x - focusX) < halfW + reach
          && Math.abs(island.position.z - focusZ) < halfH + reach;
      })
      .sort((a, b) => (
        Math.hypot(a.position.x - focusX, a.position.z - focusZ)
        - Math.hypot(b.position.x - focusX, b.position.z - focusZ)
      ));
    let budget = CHART_LOD_BUDGET_MS;
    for (const island of pending) {
      if (budget <= 0.2) break;
      const startedAt = performance.now();
      this.advanceChartLod(island, budget);
      budget -= performance.now() - startedAt;
    }
  }

  private advanceChartLod(island: Island, budgetMs: number) {
    const base = this.getIslandChartBitmap(island);
    let lod = this.islandChartLodInFlight.get(island.id);
    if (!lod) {
      const grid = THREE.MathUtils.clamp(Math.round(base.coreExtent * 2.8), 256, 512);
      const mask = new Uint8Array(grid * grid);
      // The base mask sits on a coarser grid; project it up to this one.
      const ratio = base.grid / grid;
      for (let gz = 0; gz < grid; gz++) {
        const sz = Math.min(base.grid - 1, Math.floor(gz * ratio));
        for (let gx = 0; gx < grid; gx++) {
          const sx = Math.min(base.grid - 1, Math.floor(gx * ratio));
          mask[gz * grid + gx] = base.seaMask[sz * base.grid + sx];
        }
      }
      lod = { extent: base.coreExtent, grid, row: 0, heights: new Float32Array(grid * grid), mask };
      this.islandChartLodInFlight.set(island.id, lod);
    }
    const startedAt = performance.now();
    while (lod.row < lod.grid) {
      this.sampleChartRows(island, lod.grid, lod.extent, lod.heights, lod.row, lod.row + 1, lod.mask);
      lod.row += 1;
      if (performance.now() - startedAt >= budgetMs) return;
    }
    this.islandChartLodInFlight.delete(island.id);
    this.islandChartLodCache.set(island.id, this.composeChartBitmap(
      lod.grid,
      lod.extent,
      this.shadeChartPixels(island, lod.grid, lod.extent, lod.heights, true),
      lod.mask,
    ));
    // Map iteration is insertion-ordered — drop the least recently built.
    while (this.islandChartLodCache.size > CHART_LOD_KEEP) {
      const oldest = this.islandChartLodCache.keys().next().value;
      if (oldest === undefined) break;
      this.islandChartLodCache.delete(oldest);
    }
  }

  /** Stamp an island's land bitmap centred on its true world position. */
  private stampChartBitmap(
    ctx: CanvasRenderingContext2D,
    bmp: ChartBitmap,
    island: Island,
    centerX: number,
    centerY: number,
    scale: number,
  ) {
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
    // a single smooth footprint ring. An island whose bitmap has not been
    // rasterized yet takes no marks at all this frame — a dock and a station
    // floating on bare water read as a bug; a moment's wait does not.
    const bitmap = this.pickChartBitmap(island, fullscreen ? this.mapZoom : 1);
    if (!bitmap) return;
    this.stampChartBitmap(ctx, bitmap, island, centerX, centerY, scale);

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
  }
}
