/**
 * Owns the in-match HUD: vitals, compass, storm banner, ship/keg/inventory
 * panels, weapon + combat readouts and the kill/event feed. Reads game state
 * through a narrow `HudView` handed in by Game; it never touches the scene.
 */
import * as THREE from 'three';
import { ECONOMY, FIRST_SAIL_ASSIST, KILL_STREAK_LADDER, PLAYER, RESPAWN_HOLD_MAX_SECONDS, SHIP, SHIP_UPGRADES, STORM_PHASES, WEAPONS } from '../../shared/constants/index.js';
import type { GameState, Island, IslandNpc, ItemStack, Player, Ship, ShipHole, ShipUpgradeType, WeaponInstance } from '../../shared/types/index.js';
import { cargoBallastPenalty, cargoTier, cargoTierLabel } from '../../shared/cargo.js';
import { countOpenHoles } from '../../shared/interactions.js';
import { angleWrap, dist2D, isPointInsideIslandFootprint, sampleLocalWind } from '../../shared/utils/index.js';
import type { ClientInteractKind, FloatingDamageIndicator } from '../core/Game.js';
import type { InputManager } from '../input/InputManager.js';
import type { OceanRenderer } from '../rendering/OceanRenderer.js';
import type { Renderer } from '../rendering/Renderer.js';
import type { UiRefs } from './UiRefs.js';
import { BROKER_NAME, itemDisplayName, shipClassName, weaponSlotName } from './DisplayNames.js';
import { openOnboardingCards, wireOnboardingCards } from './OnboardingCards.js';

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
  /** True while the staged-start ceremony owns the screen centre. */
  readonly startCeremonyActive: boolean;
  /** True until the player first boards their own hull — drives the first
   *  objective line ("board your ship") and the world/minimap marker. */
  readonly ownShipObjectiveActive: boolean;
  findNearbyCannonIndex(player: Player, ship: Ship): number | null;
  findRepairableHole(player: Player, ship: Ship): ShipHole | null;
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
    repairHole: ShipHole | null,
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

/**
 * Every way a voyage ends for you, as the death screen says it.
 *
 * Mirrors Match.ts's `EliminationCause` (server) plus the client-only
 * 'outlasted'. The server tags what ACTUALLY took the last of your health as
 * the blow lands, so a shark in the shallows and a tempest you swam back inside
 * the ring from stop being filed as DROWNED.
 */
export type DeathCauseKind =
  | 'ship_sunk' | 'storm' | 'drowned' | 'shark' | 'fall' | 'fire'
  | 'cannon' | 'gunshot' | 'blade' | 'explosion' | 'killed' | 'outlasted';
/** The set, as a runtime guard for the value coming off the wire. */
const DEATH_CAUSE_KINDS = new Set<string>([
  'ship_sunk', 'storm', 'drowned', 'shark', 'fall', 'fire',
  'cannon', 'gunshot', 'blade', 'explosion', 'killed', 'outlasted',
]);

export class HudController {
  constructor(private readonly view: HudView) {}

  private pocketStripSignature = '';
  private shipUpgradeSignature = '';
  /** Last painted hull-panel heading — the class only changes on a new berth. */
  private shipStatusTitleText = '';
  private shipInventorySignature = '';
  private brProgressSignature = '';
  /** The spawn island must NOT read as a discovery — the first HUD pass only
   *  seeds where the player already is. */
  private islandPresenceSeeded = false;
  private compassTapeBuilt = false;
  private crewPulseTimer: number | null = null;

  /** Called on match teardown so per-match latches don't leak into the next round. */
  resetForMatch(): void {
    this.islandPresenceSeeded = false;
    this.firstSailDone = false;
    this.legendOpenContext = null;
    this.brProgressSignature = '';
    this.goldLeaderboardSignature = '';
    this.holdCargoSignature = '';
    if (this.holdCargoEl) this.holdCargoEl.style.display = 'none';
    this.lastStreakSeen = -1;
    this.serverEliminationCause = null;
    this.deathCopySignature = '';
    this.preDeathContext = { outsideStorm: false, swimming: false, respawning: false, shipGone: false };
    if (this.crewPulseTimer !== null) {
      window.clearTimeout(this.crewPulseTimer);
      this.crewPulseTimer = null;
    }
    this.view.ui.playerCount.classList.remove('crew-pulse');
    this.resetRespawnCountdown();
    this.clearFeed();
    this.resetSimRateTracking();
    this.setOverloadChip(false);
  }

  // ─── Server-load chip ────────────────────────────────────────
  /**
   * A loaded host does not slow down honestly — it slows down INVISIBLY. The sim
   * runs a bounded number of catch-up steps per timer callback and drops the rest
   * of the backlog, so CPU starvation turns into slow motion with no warning
   * anywhere: an observed match ran at ~7% real time and looked, from inside,
   * like a game where everything had simply become very heavy.
   *
   * The tell is already on the wire. Every snapshot carries `serverTime`, so if
   * the sim clock advances slower than the client's wall clock, the sim is
   * dilating — no new message type, no new payload field, just reading what was
   * always there. A client-side main-thread stall does NOT trip it: while the
   * client is frozen `serverTime` keeps arriving and jumps forward by the length
   * of the freeze, so the ratio comes back at ~1 rather than below it.
   */
  private static readonly SIM_RATE_WINDOW_SEC = 5;
  /** Deficit (seconds of sim time owed) that counts as overloaded, and the
   *  quieter level it has to fall back under before the chip goes away. */
  private static readonly SIM_DEFICIT_TRIP_SEC = 1;
  private static readonly SIM_DEFICIT_CLEAR_SEC = 0.4;
  /** Hold the trip condition this long before saying it out loud — one frame of
   *  bad arithmetic on the way out of a stall must never flash the chip. */
  private static readonly SIM_TRIP_DWELL_MS = 1_500;

  private simRateSamples: Array<{ server: number; wall: number }> = [];
  private lastSampledServerTime = -1;
  private simTripSince = 0;
  private overloadChip: HTMLDivElement | null = null;
  private overloadShown = false;

  /**
   * Clear the sampler WHOLE. lastSampledServerTime has to go back to -1 with the
   * samples: it is the "have I already counted this reading" gate, so leaving it
   * behind on a reset means the very next reading looks like a duplicate, no
   * sample is ever taken again, and the detector goes silently blind. Found
   * exactly that way — the chip stopped being able to re-arm after a reset.
   */
  private resetSimRateTracking(): void {
    this.simRateSamples.length = 0;
    this.lastSampledServerTime = -1;
    this.simTripSince = 0;
  }

  private updateServerLoadChip(): void {
    const state = this.view.state;
    const now = performance.now() / 1000;
    // Only the live sim advances serverTime; during the staged start it is 0 by
    // design and would read as an infinite deficit.
    if (!state || state.phase !== 'playing' || !Number.isFinite(state.serverTime)) {
      this.resetSimRateTracking();
      this.setOverloadChip(false);
      return;
    }
    if (state.serverTime !== this.lastSampledServerTime) {
      this.lastSampledServerTime = state.serverTime;
      this.simRateSamples.push({ server: state.serverTime, wall: now });
    }
    while (this.simRateSamples.length > 2
      && now - this.simRateSamples[0].wall > HudController.SIM_RATE_WINDOW_SEC) {
      this.simRateSamples.shift();
    }
    const first = this.simRateSamples[0];
    const last = this.simRateSamples[this.simRateSamples.length - 1];
    if (!first || !last) return;
    // Measure against NOW, not against the newest sample: a server that has gone
    // quiet altogether owes exactly as much sim time as one that is crawling.
    const wallSpan = now - first.wall;
    if (wallSpan < HudController.SIM_RATE_WINDOW_SEC * 0.5) return;
    const deficit = wallSpan - (last.server - first.server);

    if (deficit >= HudController.SIM_DEFICIT_TRIP_SEC) {
      if (this.simTripSince === 0) this.simTripSince = performance.now();
      if (performance.now() - this.simTripSince >= HudController.SIM_TRIP_DWELL_MS) {
        this.setOverloadChip(true, deficit);
      }
    } else if (deficit <= HudController.SIM_DEFICIT_CLEAR_SEC) {
      this.simTripSince = 0;
      this.setOverloadChip(false);
    }
  }

  private setOverloadChip(on: boolean, deficitSec = 0): void {
    if (!on) {
      if (this.overloadChip) this.overloadChip.style.display = 'none';
      this.overloadShown = false;
      return;
    }
    if (!this.overloadChip) {
      const chip = document.createElement('div');
      chip.id = 'server-load-chip';
      chip.style.cssText = [
        // Below the storm clock, in the top-centre status stack where the eye
        // already goes for "what is happening to me right now" — and clear of the
        // compass bezel, which owns the very top of the screen.
        'position:fixed', 'top:88px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:60', 'pointer-events:none',
        'padding:3px 10px', 'border-radius:999px',
        'background:rgba(58,20,12,0.86)', 'border:1px solid rgba(255,138,106,0.5)',
        'color:#ffb37a', 'font-size:0.6rem', 'letter-spacing:0.14em',
        'text-transform:uppercase', 'white-space:nowrap',
        'text-shadow:0 2px 6px rgba(0,0,0,0.6)',
      ].join(';');
      document.body.appendChild(chip);
      this.overloadChip = chip;
    }
    // Repaint the number only when the whole second changes — this runs per frame.
    const behind = Math.max(1, Math.round(deficitSec));
    const label = `⚠ Server overloaded — sim ${behind}s behind`;
    if (!this.overloadShown || this.overloadChip.textContent !== label) {
      this.overloadChip.textContent = label;
    }
    this.overloadChip.style.display = 'block';
    this.overloadShown = true;
  }

  // ─── The reprieve you come back with ─────────────────────────
  /**
   * THE DEATH CAROUSEL, WITH THE SECONDS SHOWN.
   *
   * The ring crossed a learner's spawn dock, killed him six seconds after it
   * arrived, put him back on the same deck inside the same weather and killed him
   * again — three times in three minutes. The server now hands every respawn
   * STORM_RESPAWN_GRACE_SECONDS of immunity FROM THE WEATHER ONLY, and a reprieve
   * nobody can see is indistinguishable from luck: he needs to know he has fifteen
   * seconds, and to feel the moment they run out.
   *
   * Local clock, armed off the one `player_spawned` message (Game.onPlayerSpawned)
   * — no per-tick field on the wire for a chip that counts down predictably.
   */
  private stormReprieveUntilMs = 0;
  private stormReprieveAshore = false;
  private reprieveChip: HTMLDivElement | null = null;
  private reprieveChipText = '';

  noteStormReprieve(seconds: number, ashore: boolean): void {
    if (!(seconds > 0)) {
      this.stormReprieveUntilMs = 0;
      return;
    }
    this.stormReprieveUntilMs = performance.now() + seconds * 1000;
    this.stormReprieveAshore = ashore;
  }

  private updateStormReprieveChip(player: Player): void {
    const left = (this.stormReprieveUntilMs - performance.now()) / 1000;
    // Dying again inside the reprieve ends it — the count belongs to a life.
    if (left <= 0 || player.state === 'respawning' || player.state === 'eliminated') {
      this.setReprieveChip(null);
      if (left <= 0) this.stormReprieveUntilMs = 0;
      return;
    }
    const seconds = Math.max(1, Math.ceil(left));
    this.setReprieveChip(this.stormReprieveAshore
      ? `⛈ Storm reprieve ${seconds}s — put ashore inside the ring, your hull is elsewhere`
      : `⛈ Storm reprieve ${seconds}s — make sail for the ring`);
  }

  private setReprieveChip(text: string | null): void {
    if (text === null) {
      if (this.reprieveChip) this.reprieveChip.style.display = 'none';
      this.reprieveChipText = '';
      return;
    }
    if (!this.reprieveChip) {
      const chip = document.createElement('div');
      chip.id = 'storm-reprieve-chip';
      // Under the storm clock, beside the server-load chip's slot — the top-centre
      // stack is already where "what is happening to me right now" lives.
      chip.style.cssText = [
        'position:fixed', 'top:112px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:60', 'pointer-events:none',
        'padding:3px 10px', 'border-radius:999px',
        'background:rgba(14,32,58,0.86)', 'border:1px solid rgba(126,190,255,0.5)',
        'color:#a9d4ff', 'font-size:0.6rem', 'letter-spacing:0.14em',
        'text-transform:uppercase', 'white-space:nowrap',
        'text-shadow:0 2px 6px rgba(0,0,0,0.6)',
      ].join(';');
      document.body.appendChild(chip);
      this.reprieveChip = chip;
    }
    if (this.reprieveChipText !== text) {
      this.reprieveChipText = text;
      this.reprieveChip.textContent = text;
    }
    this.reprieveChip.style.display = 'block';
  }

  // ─── Respawn countdown ───────────────────────────────────────
  /**
   * The respawn count is painted off a LOCAL DEADLINE armed from the server's
   * timer, not off the raw `player.respawnTimer` in the last snapshot.
   *
   * Painting the raw field meant the number could only move when a full snapshot
   * landed and was processed, and both halves of that stall: island streaming
   * pins the main thread in bursts, and a loaded host dilates the sim itself.
   * Observed: "Respawning in 20" held for 60+ seconds, then a silent elimination
   * with the same stale digits still on screen. The staged match start already
   * hit exactly this and already solved it this way (see
   * Game.onMatchCountdownTick) — one number per real second, in order, whatever
   * the network is doing.
   *
   * Monotonic, like the start countdown: the deadline is only ever pulled
   * EARLIER. A snapshot burst that arrives out of order would otherwise walk the
   * count backwards. A LATER server timer means a fresh death, which
   * resetRespawnCountdown handles by disarming when the player stops respawning.
   */
  private respawnDeadlineMs = 0;
  /** Last respawnTimer the server sent — a change is a fresh reading to anchor on. */
  private respawnServerTimer = -1;

  private resetRespawnCountdown(): void {
    this.respawnDeadlineMs = 0;
    this.respawnServerTimer = -1;
  }

  /** performance.now() when the held copy first went up for this death; 0 = not held. */
  private respawnHeldSince = 0;

  /**
   * True when the server has deliberately PAUSED this respawn: it holds the timer
   * while the home ship is outside the storm ring (Match.updateRespawns). Same
   * geometry as the server's isShipInStormSafeZone, so the HUD says "held" for
   * the same reason the timer is not moving instead of pretending to count.
   *
   * IT MUST NEVER CLAIM A HOLD THE SERVER IS NOT KEEPING. The old reading was
   * pure geometry, so it kept promising "the count resumes when your hull is back
   * inside the ring" in the FINAL storm — a ring 12 m across with no berth and no
   * clear water in it, where the hull can never come inside and the server does
   * not hold at all. An auditor read that sentence on a grey screen for four
   * minutes. The two states the server refuses to hold in (terminal ring,
   * foundering hull) now read as what they are: a real count.
   */
  private isRespawnHeld(player: Player): boolean {
    const home = this.view.shipsById.get(player.shipId ?? '');
    if (!home) return false;
    // A hull already going down cannot be sailed back — the server stops holding.
    if (!home.alive || home.sinking) return false;
    const storm = this.view.state?.storm;
    if (!storm) return false;
    // Terminal ring: there is no "inside" left to sail to, so there is no hold.
    if (storm.phase >= STORM_PHASES.length) return false;
    return dist2D(home.position.x, home.position.z, storm.centerX, storm.centerZ) > storm.safeRadius - 5;
  }

  private respawnCountdownText(player: Player): { prompt: string; label: string } {
    const now = performance.now();
    const serverSeconds = Math.max(0, player.respawnTimer);
    if (serverSeconds !== this.respawnServerTimer) {
      this.respawnServerTimer = serverSeconds;
      const candidate = now + serverSeconds * 1000;
      this.respawnDeadlineMs = this.respawnDeadlineMs === 0
        ? candidate
        : Math.min(this.respawnDeadlineMs, candidate);
    }

    // The hold is CAPPED on the server (RESPAWN_HOLD_MAX_SECONDS). Once that
    // window is spent the count is running whatever the geometry still says, so
    // the copy stops claiming a pause it no longer has.
    const geometryHeld = this.isRespawnHeld(player);
    if (!geometryHeld) {
      this.respawnHeldSince = 0;
    } else if (this.respawnHeldSince === 0) {
      this.respawnHeldSince = now;
    }
    const heldFor = this.respawnHeldSince === 0 ? 0 : (now - this.respawnHeldSince) / 1000;
    const held = geometryHeld && heldFor < RESPAWN_HOLD_MAX_SECONDS + 1.5;
    const holdLeft = Math.max(1, Math.ceil(RESPAWN_HOLD_MAX_SECONDS - heldFor));
    // THE BLACKOUT NAMED THE WAIT AND NEVER THE CAUSE. You went from playing to
    // a dark screen counting down, with no line anywhere saying what had just
    // killed you — the one thing a dead player wants. The server tags the blow
    // (kill_event.cause) for respawns exactly as it does for eliminations.
    const blame = HudController.DEATH_COPY[this.resolveDeathCause()].blame;
    if (held) {
      // THE COPY MAY ONLY PROMISE WHAT THE WORLD CAN KEEP. It used to read "the
      // count resumes when your hull is back inside the ring" — a condition that
      // in the final storm can never occur, which is how an auditor came to read
      // it for four minutes. What is actually guaranteed is the CAP, so that is
      // what it says: a number that is ticking down on screen, whatever happens
      // to the ship. Sailing her in still lifts the hold early.
      return {
        prompt: 'Respawn held — your ship is in the storm',
        label: `${this.capitalise(blame)} · the count starts in ${holdLeft}s, sooner if she makes the ring`,
      };
    }
    const remaining = Math.ceil((this.respawnDeadlineMs - now) / 1000);
    if (remaining <= 0) {
      // The local clock ran out but the server has not spawned us yet — say so
      // honestly rather than freezing on a number that stopped meaning anything.
      return { prompt: `Respawning — ${blame}`, label: 'Waiting on the ship' };
    }
    return {
      prompt: `Respawning in ${remaining} — ${blame}`,
      label: 'Returning to your ship',
    };
  }

  private capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Flash the CREWS AFLOAT chip — the counter used to drop 10 → 7 → 5 in total silence. */
  pulseCrewsAfloat(): void {
    const chip = this.view.ui.playerCount;
    if (this.crewPulseTimer !== null) window.clearTimeout(this.crewPulseTimer);
    chip.classList.remove('crew-pulse');
    // Reflow so the animation replays on back-to-back eliminations.
    void chip.offsetWidth;
    chip.classList.add('crew-pulse');
    this.crewPulseTimer = window.setTimeout(() => {
      this.crewPulseTimer = null;
      chip.classList.remove('crew-pulse');
    }, 1000);
  }

  /** Pixels of tape per degree of bearing (matches the old strip's scale). */
  private static readonly COMPASS_PX_PER_DEG = 2.6;

  /**
   * Lay absolute marks along the tape for a FULL TURN either side of north.
   * The old single finite strip ran out: past its extent the compass bar went
   * completely blank across a whole arc of headings. With ±360° of marks the
   * ±40° window under the bezel is always populated, whatever the heading.
   */
  private buildCompassTape(): void {
    if (this.compassTapeBuilt) return;
    this.compassTapeBuilt = true;
    const tape = this.view.ui.compassTape;
    tape.textContent = '';
    const cardinals: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    const inter: Record<number, string> = { 45: 'NE', 135: 'SE', 225: 'SW', 315: 'NW' };
    for (let degrees = -360; degrees <= 720; degrees += 15) {
      const bearing = ((degrees % 360) + 360) % 360;
      const mark = document.createElement('div');
      const label = cardinals[bearing] ?? inter[bearing] ?? null;
      mark.className = `cm ${cardinals[bearing] ? 'cm-card' : inter[bearing] ? 'cm-inter' : 'cm-tick'}`;
      mark.textContent = label ?? '·';
      mark.style.left = `${degrees * HudController.COMPASS_PX_PER_DEG}px`;
      tape.appendChild(mark);
    }
  }

  // ─── The bounty, on the compass ──────────────────────────────
  //
  // A bounty was raised with a horn, a feed line and a hunter's ring on the
  // CHART — and the chart is a modal panel. So the one moment in the match that
  // tells the whole fleet where to sail could only be acted on by a player who
  // stopped sailing to open a map. The bearing belongs on the instrument that is
  // already on screen: an amber pip riding the compass strip, pinned to the
  // bezel edge with a chevron when the hunted crew is behind you, with the range
  // under it so "turn" and "how far" are one glance.
  //
  // The idiom is the chart's own-ship beacon: one colour, one shape, no legend.

  /** ±40° of tape is under the bezel; past that the pip pins and points. */
  private static readonly COMPASS_HALF_ARC_DEG = 40;
  private compassBountyMark: { root: HTMLElement; pip: HTMLElement; label: HTMLElement } | null = null;
  private compassBountySignature = '';

  /** Built in code (not markup) so the bezel keeps exactly one owner. */
  private ensureCompassBountyMark(): { root: HTMLElement; pip: HTMLElement; label: HTMLElement } | null {
    if (this.compassBountyMark) return this.compassBountyMark;
    const bezel = this.view.ui.compassTape.parentElement;
    if (!bezel) return null;
    const root = document.createElement('div');
    root.id = 'compass-bounty';
    root.style.cssText = [
      'position:absolute', 'top:0', 'left:50%', 'height:100%', 'width:0',
      'display:none', 'pointer-events:none', 'z-index:2',
    ].join(';');
    const pip = document.createElement('div');
    // A downward amber caret hung off the TOP rail, mirroring the heading caret
    // so the two read as one instrument rather than two overlapping marks.
    pip.style.cssText = [
      'position:absolute', 'top:1px', 'left:50%', 'transform:translateX(-50%)',
      'width:0', 'height:0',
      'border-left:4px solid transparent', 'border-right:4px solid transparent',
      'border-top:6px solid #ffb347',
      'filter:drop-shadow(0 0 4px rgba(255, 140, 60, 0.85))',
    ].join(';');
    const label = document.createElement('div');
    // A pill, not bare text: the range sits ON the moving tape, and amber
    // letters over a cardinal mark are two things sharing one set of pixels.
    label.style.cssText = [
      'position:absolute', 'bottom:1px', 'left:50%', 'transform:translateX(-50%)',
      'font:700 0.5rem monospace', 'letter-spacing:0.05em', 'color:#ffcb80',
      'white-space:nowrap', 'padding:0 3px', 'border-radius:3px',
      'background:rgba(24, 10, 2, 0.82)', 'text-shadow:0 1px 2px rgba(0, 0, 0, 0.95)',
    ].join(';');
    root.appendChild(pip);
    root.appendChild(label);
    bezel.appendChild(root);
    this.compassBountyMark = { root, pip, label };
    return this.compassBountyMark;
  }

  /**
   * Point the amber pip at the bountied crew.
   * @param heading the player's own heading in degrees, the same value the tape
   *   is slid by — so the pip and the cardinal letters can never disagree.
   */
  private updateBountyBearing(player: Player, heading: number): void {
    const mark = this.ensureCompassBountyMark();
    if (!mark) return;
    const state = this.view.state;
    const ownShipId = this.view.getTrackedShip()?.id ?? null;
    // Your OWN bounty is not a bearing — you are already there, and the hold
    // panel already shouts it. Only somebody else's is steerable.
    let target: Ship | null = null;
    let targetRange = Infinity;
    for (const ship of state?.ships ?? []) {
      if (!ship.bountied || !ship.alive || ship.id === ownShipId) continue;
      const range = dist2D(player.position.x, player.position.z, ship.position.x, ship.position.z);
      if (range < targetRange) { target = ship; targetRange = range; }
    }
    if (!target) {
      if (mark.root.style.display !== 'none') mark.root.style.display = 'none';
      this.compassBountySignature = '';
      return;
    }
    const bearing = (((Math.atan2(
      target.position.x - player.position.x,
      target.position.z - player.position.z,
    ) * 180) / Math.PI) % 360 + 360) % 360;
    // Signed offset in [-180, 180): which way to TURN, not which way is north.
    let delta = bearing - heading;
    delta = ((delta % 360) + 540) % 360 - 180;
    const arc = HudController.COMPASS_HALF_ARC_DEG;
    const offScreen = Math.abs(delta) > arc;
    // Pinned marks stop SHORT of the rail. The bezel fades its outer ~20% into
    // the frame, so a chevron parked at the true edge was swallowed by the very
    // gradient that makes the tape look inset.
    const clamped = THREE.MathUtils.clamp(delta, -arc, arc) * (offScreen ? 0.88 : 1);
    const px = Math.round(clamped * HudController.COMPASS_PX_PER_DEG);
    const range = targetRange >= 1000
      ? `${(targetRange / 1000).toFixed(1)}km`
      : `${Math.round(targetRange / 10) * 10}m`;
    // Repaint on whole-pixel changes only — updateHud runs every frame.
    const signature = `${px}|${offScreen ? (delta > 0 ? 'r' : 'l') : 'on'}|${range}`;
    if (signature === this.compassBountySignature) return;
    this.compassBountySignature = signature;
    mark.root.style.display = 'block';
    mark.root.style.transform = `translateX(${px}px)`;
    // Past the bezel the caret stops lying about a bearing it cannot show and
    // becomes a "keep turning this way" chevron.
    mark.pip.style.borderTop = offScreen ? '6px solid transparent' : '6px solid #ffb347';
    mark.pip.style.borderLeft = offScreen && delta > 0 ? '7px solid #ffb347' : '4px solid transparent';
    mark.pip.style.borderRight = offScreen && delta < 0 ? '7px solid #ffb347' : '4px solid transparent';
    mark.pip.style.borderBottom = offScreen ? '6px solid transparent' : '0';
    // Pinned at a rail, a centred label hangs half outside the bezel and the
    // overflow clip eats the leading digits ("00m"). Slide it back inboard.
    mark.label.style.transform = offScreen
      ? `translateX(calc(-50% ${delta > 0 ? '-' : '+'} 20px))`
      : 'translateX(-50%)';
    mark.label.textContent = range;
  }

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

    const niceName = (item: string) => itemDisplayName(item);
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
    this.updateServerLoadChip();
    this.updateStormReprieveChip(player);

    const timerSeconds = this.view.getStormTimerSeconds();
    const lastPhase = this.view.state.storm.phase >= STORM_PHASES.length - 1;
    const finalHold = lastPhase && !this.view.state.storm.shrinking && timerSeconds <= 0;
    const stormVerb = this.view.state.storm.shrinking ? 'CLOSING' : 'NEXT SHRINK';
    this.view.ui.stormPhase.textContent = finalHold
      ? 'FINAL STORM - NO SAFE HARBOR'
      : `STORM PHASE ${Math.min(this.view.state.storm.phase + 1, STORM_PHASES.length)} - ${stormVerb}`;
    this.view.ui.stormTimer.textContent = finalHold ? '' : this.view.formatStormTimer(timerSeconds);
    // m:ss, same formatter as the HUD chip and the map legend — the full map
    // used to print raw seconds ("NEXT STORM SHIFT IN 121S").
    const stormClock = this.view.formatStormTimer(timerSeconds);
    this.view.ui.mapSubtitle.textContent = finalHold
      ? 'The storm has fully closed — finish the fight'
      : this.view.state.storm.shrinking
        ? `Storm moving now · closes in ${stormClock}`
        : `Next storm shift in ${stormClock}`;

    const outsideStorm = dist2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ) > this.view.state.storm.safeRadius;
    this.sampleDeathContext(player, outsideStorm);
    // The legend's 'How to Play' footer must work on a pirate's hundredth
    // voyage, not just the one where the cards opened themselves.
    wireOnboardingCards();
    this.maybeAutoOpenLegend();
    this.updateLegendCard(player, ship);
    // "Critical" is now the flood, not a hull-HP average: she is going down
    // when the bilge is winning, or when she is carrying more leaks than any
    // crew can plank ahead of the water.
    const openLeaks = ship ? countOpenHoles(ship) : 0;
    const shipCritical = !!ship && (ship.sinking || (ship.waterLevel ?? 0) > 0.7 || openLeaks >= 6);
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
    this.renderHoldCargo(ship);
    this.renderGoldLeaderboard(player.id);
    this.view.ui.killCount.textContent = String(player.kills);
    this.view.ui.healthFill.style.width = `${Math.max(0, player.health)}%`;
    this.view.ui.armorFill.style.width = `${Math.max(0, Math.min(100, ((player.armor ?? 0) / PLAYER.MAX_ARMOR) * 100))}%`;

    if (ship) {
      // ORDERS ONLY WHEN THEY CAN BE OBEYED. Every "hold [X] at …" clause below
      // is gated on actually standing on this hull: ashore, [X] digs, chops and
      // opens chests, so a panel telling a pirate on a beach to "hold [X] at the
      // capstan" was naming a key that does something else entirely.
      const aboard = player.onShipId === ship.id;
      // Name the hull class in the panel heading: a Cutter's two guns and a
      // Man-o'-War's eight are the same three stat rows otherwise, and the
      // class is the one thing about your ship the HUD never said out loud.
      const hullTitle = `⚓ ${shipClassName(ship.type)} · Hull`;
      if (this.shipStatusTitleText !== hullTitle) {
        this.shipStatusTitleText = hullTitle;
        this.view.ui.shipStatusTitle.textContent = hullTitle;
      }
      // The four section bars are gone with the section model. What a captain
      // needs is the count of open planking and the bilge gauge beside it.
      this.view.ui.shipLeaks.textContent = openLeaks > 0
        ? `${openLeaks} LEAK${openLeaks === 1 ? '' : 'S'}${aboard ? ' — hold [X] at a hole to plank it' : ' — she is taking water'}`
        : 'Hull sound';
      this.view.ui.shipLeaks.style.color = openLeaks >= 4
        ? '#ff8a6a'
        : openLeaks > 0 ? '#ffb37a' : '#7fe0a0';
      // The wind WHERE SHE IS. PhysicsSystem sails every hull on sampleLocalWind,
      // so reading the prevailing breeze here would print a trim instruction for a
      // wind this hull is not in — the one place a captain outside the ring is
      // certain to be looking while the gale is the only thing that can save her.
      const wind = sampleLocalWind(
        this.view.ocean.getTime(),
        ship.position.x,
        ship.position.z,
        this.view.state?.storm ?? null,
      );
      const signedRelative = angleWrap(wind.direction - ship.rotation);
      // 0.92 matches PhysicsSystem's desired-trim constant + the sail-cloth luff
      // visual, so the displayed Catch% peaks exactly where the ship is fastest.
      const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
      const trimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
      const trimDelta = angleWrap(desiredTrim - ship.sailAngle);
      // MINUTE ZERO SPEAKS PLAIN. "Trim centered · Catch 62% · Trim Right [F]"
      // is three pieces of sailing vocabulary for one idea: how much of the wind
      // the sails are actually holding, and which key gets more of it. The
      // flavour stays in the nouns (canvas, capstan, rigging); the INSTRUCTION
      // is now a sentence a landsman can obey.
      const trimSide = ship.sailAngle < -0.06 ? 'angled left' : ship.sailAngle > 0.06 ? 'angled right' : 'square';
      const trimHint = Math.abs(trimDelta) < 0.08
        ? 'best angle'
        : trimDelta > 0
          ? 'turn sails right [F]'
          : 'turn sails left [Q]';
      const rig = ship.sailIntegrity < 0.99
        ? ` · Sails torn, ${Math.round(ship.sailIntegrity * 100)}% of the cloth left${aboard ? ' (hold [X] at the sails, planks in hand)' : ''}`
        : '';
      // PLAIN ENGLISH. "Wind NW -> 138deg from starboard" is a bearing, a delta
      // and an ASCII arrow, and it told a new captain nothing they could steer
      // by. One clause, one fact: where the wind is sitting on this hull.
      const windLine = `Wind ${this.windBearingPhrase(signedRelative)}${this.windPlainGloss(signedRelative)}`;
      this.updateWindVane(signedRelative, windLine);
      const sailPct = Math.round(ship.sailHeight * 100);
      const canvas = sailPct < 5 ? 'Sails furled' : `Sails ${sailPct}% out`;
      // HOW FAST SHE IS ACTUALLY GOING, measured off the hull's own velocity.
      // The only speed number the HUD ever showed was the ship card's "TOP SPEED
      // 15.0 kn", which is a stat-sheet ceiling in world units wearing a knots
      // label — an audit measured 1.26 u/s at the wheel and reasonably called the
      // card a lie. This is the reading that cannot lie: the same vector the
      // server integrates, in knots, changing as the canvas fills.
      const speedLine = this.speedPhrase(ship, wind.tailwind);
      if (!aboard) {
        // Ashore: STATE, never orders.
        this.view.ui.sailStatus.textContent =
          `${ship.anchored ? 'Anchored' : `Under way · ${speedLine}`} · ${canvas}${rig} · ${windLine}`;
      } else if (ship.anchored) {
        // The helm can weigh the anchor too now, so the panel must not send a
        // lone captain forward to the bow capstan. But "or [W] at the helm"
        // read as though [W] worked from anywhere on the quarterdeck — a new
        // captain stood on the dais leaning on W and watched nothing happen.
        // The wheel has to be TAKEN first, and the line now says so in order.
        this.view.ui.sailStatus.textContent = player.atHelm
          ? `Anchored · hold [W] to weigh anchor · ${windLine}`
          : `Anchored · hold [X] at the wheel, then [W] — or hold [X] at the capstan · ${windLine}`;
      } else {
        // Numeric trim is a HELM readout: it only means anything to the hand on
        // the wheel, and off the wheel it was just more arithmetic on screen.
        const trim = player.atHelm
          ? ` · sails ${trimSide}, catching ${Math.round(trimCatch * 100)}% of the wind · ${trimHint}`
          : '';
        this.view.ui.sailStatus.textContent = `${speedLine} · ${canvas}${rig}${trim} · ${windLine}`;
      }
      this.updateSailCoach(player, ship, signedRelative, trimCatch);
    } else {
      this.updateSailCoach(player, null, 0, 0);
      this.view.ui.sailStatus.textContent = 'No tracked ship';
      this.updateWindVane(null, '');
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
    this.announcePowerThresholds(player);
    const powerLine = this.getPowerBadge(player);
    const objectiveLine = this.getObjectiveSummary(player, ship, {
      chestsInHold,
      mappedIsland,
      closestHoarder,
      outsideStorm,
      shipCritical,
      shipOnFire,
    });
    const progLine = ship
      // "Hold 3" read as an ORDER on a strip full of key prompts — the one word
      // on the line that is a noun in this game and a verb everywhere else in
      // the HUD. Say what is actually being counted.
      ? `${objectiveLine} · ${powerLine} · Gold ${player.gold}/${ECONOMY.GOLD_WIN_TARGET} · Chests aboard ${chestsInHold} · Upgrades ${ship.upgrades.length}`
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
      `Pocket: ${wheelHeld ? '1 ' : ''}Plantain ${pk.pocketBanana}`,
      `${wheelHeld ? '2 ' : ''}Plank ${pk.pocketWood}`,
      `Ore ${pk.pocketOre ?? 0}`,
      `${wheelHeld ? '3 ' : ''}Coconut ${pk.pocketCoconut}`,
      `${wheelHeld ? '4 ' : ''}Meat ${pk.pocketMeat} / Mango ${pk.pocketMango}`,
      `Tool: ${pk.hasShovel ? 'Shovel' : 'None'}`,
    ];
    if (mappedIsland) stripParts.push(`Chart: ${mappedIsland.name}`);
    if (closestHoarder && (mappedIsland || pk.carryingChestId)) stripParts.push(`${BROKER_NAME}: ${closestHoarder.island.name}`);
    // ONE compact badge — the streak count and the powers table used to be two
    // separate entries here, and the same table again in the progress feed.
    stripParts.push(powerLine);
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
    // "Land discovered" is for land you SAILED to. The very first HUD pass just
    // records where you spawned (you are standing on your start island — the
    // banner used to hijack the match-start moment), and the whole cue stands
    // down while the start ceremony holds the screen centre.
    const isNewIsland = this.islandPresenceSeeded
      && !!insideIslandId
      && insideIslandId !== this.view.prevIsInsideIsland;
    if (isNewIsland && !this.view.startCeremonyActive) {
      const isl = this.view.state.islands.find((i) => i.id === insideIslandId);
      if (isl) {
        this.view.flashIslandBanner(isl.name);
        this.view.playIslandArrivalFanfare();
      }
    }
    this.islandPresenceSeeded = true;
    this.view.prevIsInsideIsland = insideIslandId;
    if (performance.now() > this.view.islandBannerHideAt) {
      this.view.ui.islandBanner.classList.remove('visible');
    }

    const weapon = player.atHelm ? null : player.weapons[player.activeSlot];
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
    const repairHole = ship ? this.view.findRepairableHole(player, ship) : null;
    const lookInteraction = this.view.getLookInteraction(player, ship, nearbyCannon, repairHole);
    this.view.visibleInteractKind = null;

    if (player.state !== 'respawning') this.resetRespawnCountdown();

    // Eliminated is checked FIRST and owns the centre outright. It used to fall
    // through this chain, so the last thing painted before the kill — usually a
    // respawn count the player was still reading — sat there unchanged while they
    // were silently out of the match.
    if (player.state === 'eliminated') {
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = 'Crew eliminated — spectating';
      this.view.ui.contextLabel.style.display = 'block';
      // Wave 1 gave this line; it now names the cause instead of assuming one.
      this.view.ui.contextLabel.textContent = HudController.DEATH_COPY[this.resolveDeathCause()].spectate;
    } else if (player.state === 'respawning') {
      const countdown = this.respawnCountdownText(player);
      this.view.ui.interactPrompt.style.display = 'block';
      this.view.ui.interactPrompt.textContent = countdown.prompt;
      this.view.ui.contextLabel.style.display = 'block';
      this.view.ui.contextLabel.textContent = countdown.label;
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
      if (ship?.anchored) {
        // The dead end that ate a whole playtest: W at the wheel drops canvas,
        // the ship doesn't move, and the only anchor hint lives in a far-right
        // panel while [X] here means "leave the helm". Say it where she's
        // looking, and name the key that actually works from this station.
        const raised = Math.round((ship.anchorRaiseProgress ?? 0) * 100);
        this.view.ui.contextLabel.textContent =
          `ANCHOR DOWN — she cannot move. Hold [W] to haul it up (${raised}%) · or [X] off the wheel and hold [X] at the bow capstan`;
      } else if (ship) {
        // "make and shorten sail" is the correct order and means nothing to a
        // first-time captain. The verbs are what the keys do.
        this.view.ui.contextLabel.textContent = 'At the wheel · A/D steer · W/S let the sails out and in · compass to your right';
      } else {
        this.view.ui.contextLabel.textContent = 'At the wheel';
      }
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
      this.view.ui.contextLabel.textContent = `Carrying treasure · sell to the ${BROKER_NAME} or stow on ship`;
    } else {
      this.view.ui.interactPrompt.style.display = 'none';
      // Hidden is not enough: the element KEPT its last text, so anything that
      // reads it (the debug bar, a QA probe, a screen reader) reported a prompt
      // that was not on offer — "[X] Open Chest" following a swimmer out to sea.
      this.view.ui.interactPrompt.textContent = '';
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

    this.buildCompassTape();
    const heading = (((player.rotation.x * 180) / Math.PI) % 360 + 360) % 360;
    this.view.ui.compassTape.style.transform =
      `translateX(${Math.round(-heading * HudController.COMPASS_PX_PER_DEG)}px)`;
    this.view.ui.compassTape.style.opacity = '1';
    this.updateBountyBearing(player, heading);

    if (this.view.state.phase === 'ended') {
      if (this.view.state.winnerId === this.view.localPlayerId) {
        this.showVictory(player.kills, player.gold);
      } else {
        // Being eliminated still outranks "the voyage ended" — the pirate wants
        // to know what killed THEM, not that a clock ran out somewhere.
        const reason = player.state === 'eliminated'
          ? this.paintDeathScreen(this.resolveDeathCause())
          : this.paintDeathScreen('outlasted');
        this.view.returnToLobbyAfterLoss(player.kills, player.gold, reason);
      }
    } else if (player.state === 'eliminated') {
      this.view.returnToLobbyAfterLoss(player.kills, player.gold, this.paintDeathScreen(this.resolveDeathCause()));
    } else if (player.state === 'respawning') {
      this.view.ui.deathScreen.style.display = 'none';
      // The HUD comes back with you — see body.showing-death-screen in index.html.
      document.body.classList.remove('showing-death-screen');
    }
  }

  // ─── Why you died ────────────────────────────────────────────
  /**
   * The death screen hardcoded "SHIP SUNK — Crew lost" for every death there is:
   * a cutlass on someone else's deck, drowning in open water, the storm eating a
   * pirate who never found their ship. It named a cause that was frequently just
   * false, and the one screen a losing player reads was the one screen that
   * refused to tell them anything.
   *
   * The cause is resolved from the world as it stood the FRAME BEFORE the state
   * flipped to eliminated — once you are eliminated the evidence is gone (health
   * zeroed, ship dropped, position frozen) — and a server-supplied cause, when
   * one is threaded in, always wins over the local reading.
   */
  private static readonly DEATH_COPY: Record<
    DeathCauseKind,
    { title: string; cause: string; reason: string; spectate: string; /** Short clause for the respawn blackout. */ blame: string }
  > = {
    ship_sunk: {
      title: 'SHIP SUNK',
      cause: 'Your hull went down with your crew aboard. With no ship left afloat there is no berth to respawn to.',
      reason: 'Ship sunk',
      spectate: 'Your ship went down — there is no respawn from here',
      blame: 'your ship went down',
    },
    storm: {
      title: 'TAKEN BY THE STORM',
      cause: 'The tempest tore the last of your health away. The safe circle shrinks all match — watch it on the chart [M].',
      reason: 'Lost to the storm',
      spectate: 'The storm took you — there is no respawn from here',
      blame: 'the storm took you',
    },
    drowned: {
      title: 'DROWNED',
      cause: 'You stayed under too long. Surface, or find a hull to climb back onto — [SPACE] swims up.',
      reason: 'Drowned',
      spectate: 'You went under with no ship to swim back to — no respawn from here',
      blame: 'you went under',
    },
    shark: {
      title: 'TAKEN BY A SHARK',
      cause: 'A shark had you in the water. They circle before they lunge — get out of the sea, or put a ball in one.',
      reason: 'Taken by a shark',
      spectate: 'A shark took you in the water — there is no respawn from here',
      blame: 'a shark had you',
    },
    fall: {
      title: 'BROKEN ON THE ROCKS',
      cause: 'The drop was longer than your legs. Deep water breaks a fall; bare rock and decking do not.',
      reason: 'Killed by a fall',
      spectate: 'The fall killed you — there is no respawn from here',
      blame: 'the fall broke you',
    },
    fire: {
      title: 'BURNED ALIVE',
      cause: 'You stood on a burning deck. A bucket of seawater — or getting off the fire — puts it out.',
      reason: 'Burned',
      spectate: 'You burned on a blazing deck — there is no respawn from here',
      blame: 'the fire had you',
    },
    cannon: {
      title: 'BLOWN OFF THE DECK',
      cause: 'A cannon round found you. Broadsides carry across open water — keep the hull between you and their guns.',
      reason: 'Killed by cannon fire',
      spectate: 'A cannon round finished you — there is no respawn from here',
      blame: 'a cannon round found you',
    },
    gunshot: {
      title: 'SHOT DEAD',
      cause: 'Someone put a ball through you. Break line of sight, then heal — you do not win a trade you are losing.',
      reason: 'Shot',
      spectate: 'You were shot down — there is no respawn from here',
      blame: 'you were shot',
    },
    blade: {
      title: 'CUT DOWN',
      cause: 'A cutlass finished you at arm’s length. Hold [RMB] to block — a parried swing costs them the trade.',
      reason: 'Cut down',
      spectate: 'You were cut down — there is no respawn from here',
      blame: 'a blade cut you down',
    },
    explosion: {
      title: 'BLOWN APART',
      cause: 'A powder keg went up on top of you. They can be shot at range — or defused, if you are quick.',
      reason: 'Killed by a keg',
      spectate: 'A powder keg took you — there is no respawn from here',
      blame: 'a keg went up on you',
    },
    killed: {
      title: 'YOUR CREW WAS ELIMINATED',
      cause: 'You were cut down with your ship already gone — nothing left to respawn onto.',
      reason: 'Crew eliminated',
      spectate: 'Your crew is out and your ship is gone — no respawn from here',
      blame: 'you were cut down',
    },
    outlasted: {
      title: 'ANOTHER CREW TOOK THE SEAS',
      cause: 'The voyage ended with someone else on top of the board.',
      reason: 'Outlasted',
      spectate: 'The voyage is over',
      blame: 'the voyage ended',
    },
  };

  /** A cause handed down by the server, when the message flow supplies one. */
  private serverEliminationCause: string | null = null;
  /** The world as it stood while the player was still in the fight. */
  private preDeathContext = { outsideStorm: false, swimming: false, respawning: false, shipGone: false };
  private deathCopySignature = '';

  /** Server-authoritative cause from the elimination event (Match.ts sends it on
   *  `game_over` with `died: true`). Null clears back to the local reading. */
  noteEliminationCause(cause: string | null): void {
    this.serverEliminationCause = cause;
  }

  /** Sampled every frame the player is still in the match. */
  private sampleDeathContext(player: Player, outsideStorm: boolean): void {
    if (player.state === 'eliminated') return;
    const own = player.shipId ? this.view.shipsById.get(player.shipId) ?? null : null;
    this.preDeathContext = {
      outsideStorm,
      swimming: player.state === 'swimming',
      respawning: player.state === 'respawning',
      shipGone: !own || own.alive === false || !!own.sinking,
    };
  }

  private resolveDeathCause(): DeathCauseKind {
    const server = this.serverEliminationCause;
    // The server watched the blow land. Anything it names beats a guess made
    // from where the body happened to be lying.
    if (server && server !== 'outlasted' && DEATH_CAUSE_KINDS.has(server)) {
      return server as DeathCauseKind;
    }
    const before = this.preDeathContext;
    // Waiting to respawn when the hull went out from under you: that IS the
    // ship sinking, and it is the only elimination the old title ever got right.
    if (before.respawning && before.shipGone) return 'ship_sunk';
    if (before.outsideStorm) return 'storm';
    if (before.swimming) return 'drowned';
    return 'killed';
  }

  /** Paint the title + cause line; returns the short reason for the stats block. */
  private paintDeathScreen(kind: keyof typeof HudController.DEATH_COPY): string {
    const copy = HudController.DEATH_COPY[kind];
    // This runs every frame while the screen is up — only touch the DOM on change.
    if (this.deathCopySignature !== kind) {
      this.deathCopySignature = kind;
      const title = document.getElementById('death-title');
      const cause = document.getElementById('death-cause');
      if (title) title.textContent = copy.title;
      if (cause) cause.textContent = copy.cause;
    }
    return copy.reason;
  }

  // ─── First voyage ────────────────────────────────────────────
  /** Set once a pirate has been shown the controls card. Sits beside
   *  `piratesBR.name` / `piratesBR.settings` in localStorage. */
  private static readonly SEEN_CONTROLS_KEY = 'piratesBR.seenControls';
  private legendAutoOpenChecked = false;

  /**
   * A FIRST VOYAGE IS THREE CARDS, NOT A WALL.
   *
   * What a new pirate used to get, once per browser and never again, was the
   * whole SHIP'S ORDERS card: fourteen lines of keys, stations and win
   * conditions dropped on the screen in the same second the horn went. Nobody
   * reads fourteen lines with a countdown finishing behind them, and there was
   * no way back to it — the one teaching moment the game had, spent.
   *
   * It is now three short cards — sail · fight · win — with Next and Skip, and
   * they are RE-OPENABLE forever: from How to Play in the menu, and from the
   * 'How to Play' button in the footer of the [L] card. The persisted flag only
   * decides whether they open THEMSELVES.
   */
  private maybeAutoOpenLegend(): void {
    if (this.legendAutoOpenChecked) return;
    if (this.view.state?.phase !== 'playing') return;
    if (this.view.startCeremonyActive) return;
    if (this.view.input.isSupplyWheelOpen()) return;
    this.legendAutoOpenChecked = true;
    let seen = false;
    try { seen = localStorage.getItem(HudController.SEEN_CONTROLS_KEY) === '1'; } catch { /* private mode */ }
    if (seen) return;
    try { localStorage.setItem(HudController.SEEN_CONTROLS_KEY, '1'); } catch { /* private mode */ }
    openOnboardingCards();
  }

  // ─── Ship's Orders: a card, not a curtain ────────────────────
  /**
   * SHIP'S ORDERS opened itself over the WHOLE SCREEN and then simply stayed
   * there: it was still parked over the view at 13 knots at night, it came back
   * on a second join, and nothing but [L] ever took it away. A tutorial card
   * that outlives the tutorial is a blindfold.
   *
   * Three rules, all of them about giving the screen back:
   *   · the first meaningful VERB dismisses it — board, take the helm, make
   *     sail, or fire a shot means the reading is over;
   *   · it never sits over a STATION — at the wheel, on a gun or up the mast the
   *     card is in the way of the very thing it was explaining;
   *   · after LEGEND_DOCK_MS it shrinks to a side panel and stops covering the
   *     sea, so a slow reader keeps the text without losing the horizon.
   */
  private static readonly LEGEND_DOCK_MS = 10_000;
  /** Match state at the moment the card opened — the baseline a "verb" is
   *  measured against. Null whenever the card is shut. */
  private legendOpenContext: { at: number; onShipId: string | null; sailHeight: number; ammo: number } | null = null;

  private totalCarriedAmmo(player: Player): number {
    let total = 0;
    for (const weapon of player.weapons) if (weapon) total += weapon.ammo;
    return total;
  }

  private updateLegendCard(player: Player, ship: Ship | null): void {
    const legend = document.getElementById('controls-hint');
    if (!legend) return;
    if (legend.style.display !== 'block') {
      this.legendOpenContext = null;
      legend.classList.remove('docked');
      return;
    }
    const closeLegend = () => {
      legend.style.display = 'none';
      legend.classList.remove('docked');
      this.legendOpenContext = null;
    };
    // At a station the card is pure obstruction — it is covering the wheel,
    // the gun sights or the crow's nest view it exists to talk about.
    if (player.atHelm || player.atCannon || player.atCrowNest || player.mastClimb !== null) {
      closeLegend();
      return;
    }
    if (!this.legendOpenContext) {
      this.legendOpenContext = {
        at: performance.now(),
        onShipId: player.onShipId,
        sailHeight: ship?.sailHeight ?? 0,
        ammo: this.totalCarriedAmmo(player),
      };
      return;
    }
    const opened = this.legendOpenContext;
    const boarded = player.onShipId !== null && player.onShipId !== opened.onShipId;
    // Only HER hands count as making sail. The opening horn hoists canvas to
    // half on every hull, and reading that as the player's verb slammed the
    // card shut a frame after it opened — the pirate never saw it at all.
    const madeSail = !!ship && player.onShipId === ship.id
      && Math.abs(ship.sailHeight - opened.sailHeight) > 0.02;
    const fired = this.totalCarriedAmmo(player) < opened.ammo;
    if (boarded || madeSail || fired) {
      closeLegend();
      return;
    }
    if (performance.now() - opened.at > HudController.LEGEND_DOCK_MS) legend.classList.add('docked');
  }

  private updateWeaponHud(activeSlot: number, activeWeapon: WeaponInstance | null, loadout: Array<WeaponInstance | null>) {
    for (const [slotIndex, slotEl] of this.view.ui.weaponSlots.entries()) {
      slotEl.classList.toggle('active', slotIndex === activeSlot);
      const weapon = loadout[slotIndex];
      const nameEl = slotEl.querySelector('.wname');
      const ammoEl = slotEl.querySelector('.ammo');
      if (nameEl) {
        nameEl.textContent = weapon ? weaponSlotName(weapon.weaponId) : 'Empty';
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

  /** Bilge water gauge — vertical ship-silhouette fill, trend arrow, red alarm > 75%.
   *  Shows for the deck you are standing on, and ALSO for your own hull while
   *  you are in the water beside her: the moment that mattered most (swimming
   *  back to a flooding ship) used to be the one moment the gauge went blank,
   *  even though the flooding audio was already playing. */
  private updateWaterGauge(player: Player) {
    const aboard = player.onShipId ? this.view.shipsById.get(player.onShipId) ?? null : null;
    const own = player.shipId ? this.view.shipsById.get(player.shipId) ?? null : null;
    const overboard = !aboard
      && !!own
      && !own.sinking
      && (own.waterLevel ?? 0) > 0.02
      && dist2D(player.position.x, player.position.z, own.position.x, own.position.z) < 80;
    const ship = aboard ?? (overboard ? own : null);
    this.view.ui.waterGaugeTitle.textContent = overboard ? 'Your Ship' : 'Bilge';
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
      && dist2D(player.position.x, player.position.z, ship.position.x, ship.position.z) < 58;
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

  // ─── Hold cargo + bounty board ───────────────────────────────
  // The gold race is the signature mechanic of this BR and for most of its life
  // it read as a number in a box. These two readouts are the HUD half of making
  // it physical: what your own hull is CARRYING (and what that costs you in
  // knots), and who out there is worth hunting.

  /** Lazily built so no HTML/UiRefs change is needed — it lives beside the gold
   *  counter and only appears once there is actually cargo in the hold. */
  private holdCargoEl: HTMLDivElement | null = null;
  private holdCargoSignature = '';

  private ensureHoldCargoEl(): HTMLDivElement | null {
    if (this.holdCargoEl?.isConnected) return this.holdCargoEl;
    const host = this.view.ui.goldAmount.parentElement;
    if (!host) return null;
    const el = document.createElement('div');
    el.id = 'hold-cargo';
    el.style.cssText = [
      'font-size:0.52rem',
      'letter-spacing:0.07em',
      'text-transform:uppercase',
      'font-family:monospace',
      'color:#d9b45e',
      'margin-top:2px',
      'white-space:nowrap',
    ].join(';');
    el.style.display = 'none';
    host.appendChild(el);
    this.holdCargoEl = el;
    return el;
  }

  /**
   * "HOLD: LADEN · −9% knots". A crew hauling most of a win is sailing a
   * treasure galleon: the crates are in the hold, the hull is slower for it, and
   * the pirate flying it deserves to be told in knots, not vibes.
   */
  private renderHoldCargo(ship: Ship | null): void {
    const el = this.ensureHoldCargoEl();
    if (!el) return;
    const cargo = Math.max(0, Math.floor(ship?.cargoGold ?? 0));
    const signature = `${cargo}|${ship?.bountied ? 1 : 0}`;
    if (signature === this.holdCargoSignature) return;
    this.holdCargoSignature = signature;
    if (cargo <= 0) {
      el.style.display = 'none';
      return;
    }
    const penalty = Math.round(cargoBallastPenalty(cargo) * 100);
    const label = cargoTierLabel(cargo).toUpperCase();
    el.style.display = 'block';
    el.textContent = ship?.bountied
      ? `HOLD: ${label} · ${cargo}g · −${penalty}% · HUNTED`
      : `HOLD: ${label} · ${cargo}g · −${penalty}% knots`;
    el.style.color = ship?.bountied ? '#ff9d5c' : cargoTier(cargo) >= 3 ? '#ffd278' : '#d9b45e';
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

    const hasHull = ship.upgrades.some((u) => u.type === 'hull_reinforcement');
    const hasCannons = ship.upgrades.some((u) => u.type === 'charged_cannons');
    const hasSails = ship.upgrades.some((u) => u.type === 'swift_sails');

    const cannonBaseDmg = SHIP.CANNON_DAMAGE_HULL;
    const cannonDmg = Math.round(cannonBaseDmg * (hasCannons ? SHIP_UPGRADES.CANNON_DAMAGE_MULT : 1));
    // THE CARD MAY NOT QUOTE A SPEED. It printed "TOP SPEED 15.0 kn" — maxSpeed,
    // which is a metres-per-second ceiling wearing a knots label and reachable
    // only on a trimmed broad reach. An auditor sailing at 1.26 u/s read it as a
    // straight lie and was right to. The LIVE number lives in the sail panel now
    // (speedPhrase, measured off the hull's velocity); what belongs on a card
    // about UPGRADES is the delta the upgrade buys, which is what the other two
    // rows already say ("−30% flood", "+45%").
    const speedRating = hasSails
      ? `Swift <em>(+${Math.round((SHIP_UPGRADES.SWIFT_SPEED_MULT - 1) * 100)}%)</em>`
      : 'Standard';

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
          <span class="ship-stat-label">Rigging</span>
          <span class="ship-stat-value">${speedRating}</span>
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

  // ─── Speed, measured rather than advertised ──────────────────
  /**
   * One world unit is one metre (islands are sized in them, the ring is quoted in
   * them), so a hull's speed in knots is |velocity| × this. Kept here beside the
   * only readout that uses it: the number is a UNIT CONVERSION of the server's own
   * velocity vector, never a stat-sheet figure.
   */
  private static readonly KNOTS_PER_UNIT = 1.94384;

  /**
   * "making 21.6 kn", and whether the storm is doing the pushing.
   *
   * The ship card advertised "TOP SPEED 15.0 kn" — SHIP_STATS.maxSpeed printed
   * with a knots label, which is neither the unit (it is metres per second) nor
   * reachable on most points of sail. A fresh-eyes audit measured 1.26 u/s at the
   * wheel, read the card, and correctly concluded the HUD was lying to it. The
   * honest fix is to stop advertising and start MEASURING: this is the hull's own
   * velocity, converted, and it is the number that moves when the yard comes round.
   *
   * The gale gets named when it is helping. Outside the ring sampleLocalWind turns
   * the wind into a storm gale blowing toward shelter, which can more than double
   * a hull's speed — a captain who sees 22 kn out of nowhere is owed the reason.
   */
  private speedPhrase(ship: Ship, tailwind: number): string {
    const knots = Math.hypot(ship.velocity.x, ship.velocity.z) * HudController.KNOTS_PER_UNIT;
    const made = knots < 0.15 ? 'dead in the water' : `making ${knots.toFixed(1)} kn`;
    return tailwind > 0.05 ? `${made} · STORM GALE ASTERN` : made;
  }

  // ─── The first sail: nobody may be left leaning on W ─────────
  /** performance.now() when the canvas first went slack at this player's wheel. */
  private sailCoachSince = 0;
  private sailCoachEl: HTMLDivElement | null = null;
  private sailCoachText = '';

  /**
   * A CAPTAIN WHO IS GETTING NO WIND MUST BE TOLD, IN THE MIDDLE OF THE SCREEN.
   *
   * The trap the audit fell into: the objective said "hold W to get under way", so
   * it held W. The anchor came up, the canvas came down, and the ship made 0.3 u/s
   * and decayed, because a square yard pointed near the wind catches almost
   * nothing (PhysicsSystem's polar floor is 0.10 in irons). Everything needed to
   * escape that was on screen — in a right-hand side panel, in small type, behind
   * sailing vocabulary. Nobody reads a panel while nothing is happening.
   *
   * FIRST_SAIL_ASSIST trims the yard on the first anchor-up, so this is the second
   * net: the two ways to make no way each get their own instruction, and they are
   * different instructions. Yard wrong → brace it ([Q]/[F]). Bow into the wind →
   * no trim on earth helps, STEER off it ([A]/[D]). Only at the wheel, only after
   * FIRST_SAIL_ASSIST.COACH_AFTER_SECONDS of it, so a hull passing through the
   * no-go cone mid-tack never gets shouted at.
   */
  private updateSailCoach(
    player: Player,
    ship: Ship | null,
    signedRelative: number,
    trimCatch: number,
  ): void {
    const offWind = Math.PI - Math.abs(angleWrap(signedRelative));
    const inIrons = offWind <= SHIP.SAIL_NO_GO_ANGLE;
    const stalled = !!ship
      && player.atHelm
      && !ship.anchored
      && player.state === 'alive'
      && ship.sailHeight > 0.08
      && (inIrons || trimCatch < FIRST_SAIL_ASSIST.COACH_CATCH);
    if (!stalled) {
      this.sailCoachSince = 0;
      this.setSailCoach(null);
      return;
    }
    const now = performance.now();
    if (this.sailCoachSince === 0) this.sailCoachSince = now;
    if ((now - this.sailCoachSince) / 1000 < FIRST_SAIL_ASSIST.COACH_AFTER_SECONDS) return;
    this.setSailCoach(inIrons
      ? 'Bow into the wind — steer [A] or [D] until the sails fill'
      : 'Sails are slack — press [Q] or [F] to swing the yard into the wind');
  }

  private setSailCoach(text: string | null): void {
    if (text === null) {
      if (this.sailCoachEl) this.sailCoachEl.style.display = 'none';
      this.sailCoachText = '';
      return;
    }
    if (!this.sailCoachEl) {
      const el = document.createElement('div');
      el.id = 'sail-coach-hint';
      // Deliberately the pointer-lock hint's own look (index.html
      // #pointer-lock-hint): the game already taught the player that a gold pill
      // in the middle of the screen is an instruction they can act on. It sits one
      // pill LOWER, because that hint is still up whenever the pointer is unlocked
      // and a paint check caught the two occupying the same 34 px of screen.
      el.style.cssText = [
        'position:fixed', 'left:50%', 'top:clamp(186px,24vh,256px)', 'transform:translateX(-50%)',
        'z-index:95', 'pointer-events:none',
        'padding:9px 16px', 'border-radius:999px',
        'background:rgba(4,14,28,0.85)', 'border:1px solid rgba(201,168,76,0.34)',
        'color:#f0ddb2', 'font-size:0.74rem', 'letter-spacing:0.18em',
        'text-transform:uppercase', 'white-space:nowrap',
        'text-shadow:0 2px 6px rgba(0,0,0,0.6)',
      ].join(';');
      document.body.appendChild(el);
      this.sailCoachEl = el;
    }
    if (this.sailCoachText !== text) {
      this.sailCoachText = text;
      this.sailCoachEl.textContent = text;
    }
    this.sailCoachEl.style.display = 'block';
  }

  // ─── Wind, in words ──────────────────────────────────────────
  /**
   * Where the wind sits relative to a hull's bow, said the way a sailor says it.
   *
   * The old line was "Wind NW -> 138deg from starboard": a compass bearing, a
   * relative angle and an ASCII arrow, three numbers deep, printed twice on
   * screen. None of it told a captain what to do with the wheel. The sectors are
   * the classic points of sail, so the words line up with the speed the physics
   * actually gives (bow = crawl, beam/quarter = fast).
   *
   * THE SENTENCE WAS BACK TO FRONT FOR MONTHS, AND IT IS THE FIRST-SAIL TRAP.
   * `relative` is the yaw the wind BLOWS TOWARD, minus the heading (PhysicsSystem's
   * convention: rel 0 is a dead run, |rel| ≈ π is head to wind, which is why the
   * polar reads offWind = π − |rel|). A sailor names the wind by where it comes
   * FROM, so every sector here was the opposite of the truth: a live probe caught
   * the panel reading "Wind astern — from behind" on a hull sitting at the 0.10
   * in-irons floor making 1.3 u/s, and "dead ahead" on a dead run. A learner who
   * believes that line steers exactly the wrong way and holds W into the wind
   * forever, which is the plateau the audit reported. The vane arrow was already
   * flipping the angle (`degrees + 180`) — the words simply never did.
   */
  private windBearingPhrase(relative: number): string {
    // Where it comes FROM: the source bearing, which is what a sailor names.
    const wrapped = angleWrap(relative + Math.PI);
    const deg = Math.abs(THREE.MathUtils.radToDeg(wrapped));
    const side = wrapped < 0 ? 'port' : 'starboard';
    if (deg <= 22) return 'dead ahead';
    if (deg >= 158) return 'astern';
    if (deg < 67) return `on the ${side} bow`;
    if (deg <= 112) return `on the ${side} beam`;
    return `on the ${side} quarter`;
  }

  /**
   * The same bearing said the way a landsman would say it.
   *
   * "Wind on the port quarter" is correct, it is in voice, and in minute zero it
   * is four words that mean nothing: a new captain does not know port from
   * starboard, let alone a quarter from a beam. The nautical phrase stays — it
   * is what the ship's panel and the vane chip are FOR — and this rides behind
   * it on the panel only, so the flavour teaches instead of gatekeeping. Empty
   * for 'dead ahead', which needs no translation.
   */
  private windPlainGloss(relative: number): string {
    // Same inversion as windBearingPhrase: "from behind" has to mean the wind is
    // behind you, which is rel ≈ π, not rel ≈ 0.
    const wrapped = angleWrap(relative + Math.PI);
    const deg = Math.abs(THREE.MathUtils.radToDeg(wrapped));
    const hand = wrapped < 0 ? 'left' : 'right';
    if (deg <= 22) return '';
    if (deg >= 158) return ' — from behind';
    if (deg < 67) return ` — from ahead-${hand}`;
    if (deg <= 112) return ` — from your ${hand}`;
    return ` — from behind-${hand}`;
  }

  private windVane: { root: HTMLElement; arrow: HTMLElement; text: HTMLElement } | null = null;
  private windVaneSignature = '';

  /**
   * The vane beside the compass bezel. The arrow streams DOWNWIND — the way the
   * wind is shoving the hull — which is the direction a real masthead pennant
   * points, so it reads without a legend. `relative` is bow-relative, matching
   * the sail panel's sentence exactly (one frame, one story).
   */
  private updateWindVane(relative: number | null, sentence: string): void {
    if (!this.windVane) {
      const root = document.getElementById('wind-vane');
      const arrow = document.getElementById('wind-vane-arrow');
      const text = document.getElementById('wind-vane-text');
      if (!root || !arrow || !text) return;
      this.windVane = { root, arrow, text };
    }
    const vane = this.windVane;
    if (relative === null) {
      vane.root.style.display = 'none';
      this.windVaneSignature = '';
      return;
    }
    vane.root.style.display = '';
    const phrase = this.windBearingPhrase(relative);
    // Repaint on whole-degree changes only — this runs every frame.
    const degrees = Math.round(THREE.MathUtils.radToDeg(angleWrap(relative)));
    const signature = `${degrees}:${phrase}`;
    if (signature === this.windVaneSignature) return;
    this.windVaneSignature = signature;
    // The glyph is an ↑ pointing at the bow, and `relative` is already the yaw the
    // wind BLOWS TOWARD relative to that bow — so streaming downwind is a straight
    // rotation. The old `+ 180` pointed it upwind while the words said the opposite
    // thing about the same angle; both halves of the chip are now the same story as
    // the physics (see windBearingPhrase).
    vane.arrow.style.transform = `rotate(${degrees}deg)`;
    vane.text.textContent = phrase.replace('on the ', '');
    vane.root.title = sentence;
  }

  // ─── Kill-streak powers ──────────────────────────────────────
  /** The whole reward ladder, said once — in the legend, and in the feed at the
   *  moment a threshold actually lands. It is NOT status text.
   *  Built from KILL_STREAK_LADDER so the copy can never quote a rung the
   *  server does not award (the legend said "20 · tsunami" for months while a
   *  ten-crew lobby made 20 straight kills a thing nobody had ever seen). */
  private static readonly POWER_TABLE = `Kill-streak rewards: ${
    KILL_STREAK_LADDER.map((tier, i) => (i === 0 ? `${tier.kills} kills · ${tier.label}` : `${tier.kills} · ${tier.label}`))
      .join('  ·  ')
  }`;

  /** Streak seen on the previous HUD pass; −1 means "not seeded yet". */
  private lastStreakSeen = -1;

  /**
   * The full powers table used to print in BOTH always-on strips from the first
   * second of the match — a rules dump aimed at a player with zero kills who had
   * not yet found their own ship. The badge carries the state; the table now
   * speaks exactly once, when a threshold is genuinely crossed.
   */
  private announcePowerThresholds(player: Player): void {
    const streak = player.playerKillStreak;
    if (this.lastStreakSeen < 0) {
      this.lastStreakSeen = streak;
      return;
    }
    if (streak > this.lastStreakSeen) {
      for (const { kills: threshold } of KILL_STREAK_LADDER) {
        if (this.lastStreakSeen < threshold && streak >= threshold) {
          this.pushFeed(HudController.POWER_TABLE, '#7fe7ff');
          break;
        }
      }
    }
    this.lastStreakSeen = streak;
  }

  /** Compact powers badge for the always-on strips: one glance, no rules. */
  private getPowerBadge(player: Player) {
    const ready: string[] = [];
    if (player.superCannonballs > 0) ready.push(`Super ×${player.superCannonballs}`);
    if (player.megaKegs > 0) ready.push(`Mega keg ×${player.megaKegs}`);
    if (player.tsunamiCharges > 0) ready.push(`Tsunami ×${player.tsunamiCharges}`);
    if (ready.length > 0) return `⚡ ${ready.join(' · ')} READY`;

    const next = KILL_STREAK_LADDER.find((tier) => player.playerKillStreak < tier.kills)?.kills ?? null;
    return next
      ? `Streak ${player.playerKillStreak}/${next} ⚡`
      : `Streak ${player.playerKillStreak} ⚡`;
  }

  /**
   * THE MISSING BEAT. "Board your ship" used to hand straight over to "claim
   * upgrades, raid ships, and sell treasure" the instant a boot touched the
   * planking — a pirate who had never sailed anything was told to go raiding
   * while her hull sat at the berth with the anchor down and no one on the
   * wheel. One beat sits between the two: take the wheel, then hold W.
   *
   * It is a ONE-SHOT. Once she has had the helm, or the ship is genuinely under
   * way, the funnel is spent and the open objective owns the line for good —
   * dropping anchor in a bay two minutes later must not re-run the tutorial.
   */
  private firstSailDone = false;

  private firstSailPending(player: Player, ship: Ship | null): boolean {
    if (this.firstSailDone) return false;
    if (!ship || player.onShipId !== ship.id) return false;
    const underWay = !ship.anchored && ship.sailHeight > 0.05;
    if (player.atHelm || underWay) {
      this.firstSailDone = true;
      return false;
    }
    return true;
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
    // First thing a pirate must actually do: get aboard. Clears the moment they
    // board (see Game.updateOwnShipObjective), so it never nags a sailing crew.
    if (this.view.ownShipObjectiveActive && !context.outsideStorm) {
      return 'Objective: board your ship — follow the gold sail marker';
    }
    if (context.outsideStorm) return 'Objective: sail inside the storm circle';
    if (context.shipCritical) return 'Objective: repair hull before the ship goes down';
    if (context.shipOnFire) return 'Objective: douse fire at the repair point';
    // Aboard, but nothing is moving yet — the one beat between boarding and the
    // open game (see firstSailPending; spent the moment she has the wheel).
    if (this.firstSailPending(player, ship)) {
      return 'Objective: take the helm [X] at the wheel, then hold W to get under way';
    }
    if (player.carryingChestId && context.closestHoarder) {
      return `Objective: sell chest at ${context.closestHoarder.island.name}`;
    }
    if (context.chestsInHold > 0 && context.closestHoarder) {
      return `Objective: deliver ${context.chestsInHold} chest${context.chestsInHold === 1 ? '' : 's'} to ${context.closestHoarder.island.name}`;
    }
    if (context.mappedIsland) return `Objective: dig the ${BROKER_NAME}'s marks on ${context.mappedIsland.name}`;
    if (player.gold >= ECONOMY.GOLD_WIN_TARGET * 0.72) return 'Objective: protect your lead and finish the gold run';
    if (ship && ship.upgrades.length < 2) return 'Objective: claim upgrades, raid ships, and sell treasure';
    return 'Objective: raid ships, sell treasure, and stay ahead of the storm';
  }

  // ─── Event feed ──────────────────────────────────────────────
  /** How long a line sits before it fades, and the fade itself. */
  private static readonly FEED_HOLD_MS = 3_000;
  private static readonly FEED_FADE_MS = 300;
  /** Live lines keyed by their exact text, so a repeat can find its own row. */
  private feedRows = new Map<string, {
    el: HTMLDivElement;
    countEl: HTMLSpanElement | null;
    count: number;
    fadeTimer: number;
    dropTimer: number;
  }>();

  private clearFeed(): void {
    for (const row of this.feedRows.values()) {
      window.clearTimeout(row.fadeTimer);
      window.clearTimeout(row.dropTimer);
      row.el.remove();
    }
    this.feedRows.clear();
  }

  /**
   * One line in the event feed.
   *
   * Repeats COALESCE into a ×N counter instead of stacking. Stowing a haul of
   * chests fired five byte-identical "Chest stowed aboard: base 690 gold before…"
   * lines at once, which filled the whole panel with the same sentence — and
   * because every one of them was clipped at the same word, the panel managed to
   * be both entirely full and entirely uninformative.
   *
   * And the lines WRAP. The panel's stylesheet rule is `white-space: nowrap` with
   * an ellipsis, so any message longer than a narrow column lost its payload —
   * the gold number in that very line is past the cut. Wrapping is set here,
   * inline, beside the other per-line styling this method already owns.
   */
  pushFeed(message: string, color = '#e7e1d4') {
    const existing = this.feedRows.get(message);
    if (existing) {
      existing.count += 1;
      if (existing.countEl) existing.countEl.textContent = ` ×${existing.count}`;
      // Repeats restart the dwell and lift the line back to the top: the newest
      // event belongs where the eye already is.
      existing.el.style.opacity = '1';
      existing.el.style.transform = '';
      this.view.ui.killFeed.prepend(existing.el);
      window.clearTimeout(existing.fadeTimer);
      window.clearTimeout(existing.dropTimer);
      this.armFeedExpiry(message, existing);
      return;
    }

    const item = document.createElement('div');
    const text = document.createElement('span');
    text.textContent = message;
    item.appendChild(text);
    const countEl = document.createElement('span');
    countEl.style.opacity = '0.8';
    countEl.style.fontWeight = '700';
    item.appendChild(countEl);
    item.style.color = color;
    item.style.marginBottom = '8px';
    item.style.textShadow = '0 2px 6px rgba(0, 0, 0, 0.55)';
    // Beat the panel's nowrap/ellipsis rule — a truncated payline is a line that
    // cost a slot and said nothing.
    item.style.whiteSpace = 'normal';
    item.style.overflow = 'visible';
    item.style.textOverflow = 'clip';
    item.style.overflowWrap = 'anywhere';
    item.style.lineHeight = '1.25';
    item.style.textAlign = 'right';
    this.view.ui.killFeed.prepend(item);

    const row = { el: item, countEl, count: 1, fadeTimer: 0, dropTimer: 0 };
    this.feedRows.set(message, row);
    this.armFeedExpiry(message, row);

    while (this.view.ui.killFeed.childElementCount > 5) {
      const oldest = this.view.ui.killFeed.lastElementChild;
      if (!oldest) break;
      this.dropFeedElement(oldest);
    }
  }

  private armFeedExpiry(
    message: string,
    row: { el: HTMLDivElement; fadeTimer: number; dropTimer: number },
  ): void {
    row.fadeTimer = window.setTimeout(() => {
      row.el.style.opacity = '0';
      row.el.style.transform = 'translateY(-6px)';
      row.el.style.transition = `opacity ${HudController.FEED_FADE_MS}ms ease, transform ${HudController.FEED_FADE_MS}ms ease`;
    }, HudController.FEED_HOLD_MS);
    row.dropTimer = window.setTimeout(() => {
      // Forget the key too, or the next identical event would bump a ×N counter
      // on a row that is no longer on screen.
      if (this.feedRows.get(message) === row) this.feedRows.delete(message);
      row.el.remove();
    }, HudController.FEED_HOLD_MS + HudController.FEED_FADE_MS);
  }

  /** Evict one element from the feed, cancelling whatever timers it still owns. */
  private dropFeedElement(el: Element): void {
    for (const [key, row] of this.feedRows) {
      if (row.el !== el) continue;
      window.clearTimeout(row.fadeTimer);
      window.clearTimeout(row.dropTimer);
      this.feedRows.delete(key);
      break;
    }
    el.remove();
  }

  showVictory(kills: number, gold: number) {
    this.view.ui.winStats.innerHTML = `<div>Kills: ${kills}</div><div>Gold: ${gold}</div>`;
    this.view.ui.winScreen.style.display = 'flex';
  }
}
