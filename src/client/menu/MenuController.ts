import type {
  LobbyUpdatePayload, QueueUpdatePayload, PlayerStatsRecord, MatchStartPayload, WelcomePayload,
} from '../../shared/types/index.js';
import {
  MATCH_TOTAL_SHIPS, MODES, MODE_IDS, botFillFor, isModeId, modeSpec, type ModeId,
} from '../../shared/constants/index.js';
import type { NetworkClient } from '../network/NetworkClient.js';
import type { SoundEngine } from '../audio/SoundEngine.js';
import type { InputManager } from '../input/InputManager.js';
import { openOnboardingCards } from '../ui/OnboardingCards.js';
import { installModalStack, modalStack } from '../ui/ModalStack.js';
import {
  classifyRenderer, decideRenderQuality, loadQualityPreference, parseRenderQuality, renderQualityLabel,
  saveAutoTierCeiling, saveQualityPreference,
  type QualityPreference, type RenderQuality,
} from '../rendering/QualityPreference.js';
import {
  describeFillCap, fillCapReport, fillClassFor, tierShadowMapSize, type FillCapReport,
} from '../rendering/FrameGovernor.js';

const STORAGE_KEY = 'piratesBR.name';
const SETTINGS_KEY = 'piratesBR.settings';

type MenuPanel = 'main' | 'lobby' | 'queue' | 'settings' | 'howto';

interface PersistedSettings {
  volume: number;       // 0–1
  muted: boolean;
  sensitivity: number;  // 0.2–2.0
}

interface MenuControllerOptions {
  network: NetworkClient;
  audio: SoundEngine;
  input?: InputManager;
  onMatchStart: (payload: MatchStartPayload) => void;
  onReturnToMenu?: () => void;
  /** Queue popped — the cohort is being placed. Fires once per queue session so
   *  the game can open the CREW FOUND beat before the menu tears down. */
  onCrewFound?: () => void;
  /** LIVE state from the frame governor, or null before a renderer exists. The
   *  settings panel is the only place in the product that can answer "what am I
   *  actually running", and until this existed it could not: it printed the
   *  STARTUP tier and nothing about the resolution, the shadow map or the
   *  ladder the machine had spent the last ten minutes walking down. */
  getGovernorStatus?: () => GovernorStatus | null;
}

/** The subset of Renderer.getGovernorStatus the panel prints. Declared here so
 *  the menu does not have to import the renderer. */
export interface GovernorStatus {
  enabled: boolean;
  mode: 'target' | 'floor' | 'off';
  scalar: number;
  targetFps: number;
  pixelRatio: number;
  shadowMapSize: number;
  /** What the GPU class's fill ceiling held under the tier, if anything (airsafe). */
  fillCap?: FillCapReport | null;
  label: string;
}

export class MenuController {
  private network: NetworkClient;
  private audio: SoundEngine;
  private inputMgr: InputManager | null;
  private onMatchStartCb: (payload: MatchStartPayload) => void;
  private onReturnToMenuCb: (() => void) | null;
  private onCrewFoundCb: (() => void) | null;
  private getGovernorStatusCb: (() => GovernorStatus | null) | null;
  /** Polls the governor only while the panel is up — the label is live, and a
   *  timer running behind a hidden panel is a timer nobody asked for. */
  private governorPollTimer: number | null = null;
  /** One CREW FOUND beat per queue session (the server may repeat the payload). */
  private crewFoundFired = false;

  // DOM refs
  private screen!: HTMLElement;
  private panelMain!: HTMLElement;
  private panelLobby!: HTMLElement;
  private panelQueue!: HTMLElement;
  private panelSettings!: HTMLElement;
  private panelHowto!: HTMLElement;
  private howtoBtn!: HTMLButtonElement;
  private howtoBackBtn!: HTMLButtonElement;
  private howtoControls!: HTMLElement;
  private settingsBtn!: HTMLButtonElement;
  private settingsBackBtn!: HTMLButtonElement;
  private settingsVolumeSlider!: HTMLInputElement;
  private settingsVolumeVal!: HTMLElement;
  private settingsMuteCheckbox!: HTMLInputElement;
  private settingsSensSlider!: HTMLInputElement;
  private settingsSensVal!: HTMLElement;
  private settingsQualitySelect!: HTMLSelectElement;
  private settingsQualityNote!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private soloBtn!: HTMLButtonElement;
  private createPartyBtn!: HTMLButtonElement;
  private modeControlMain!: HTMLElement;
  private joinCodeInput!: HTMLInputElement;
  private joinConfirmBtn!: HTMLButtonElement;
  private menuStatus!: HTMLElement;
  private statsMatches!: HTMLElement;
  private statsWins!: HTMLElement;
  private statsKills!: HTMLElement;
  private statsDeaths!: HTMLElement;
  private statsGold!: HTMLElement;
  private statsBest!: HTMLElement;
  private statsBtn!: HTMLButtonElement;
  private statsBackdrop!: HTMLElement;
  private statsPanelName!: HTMLElement;
  private statsPanelBody!: HTMLElement;
  private statsCloseBtn!: HTMLButtonElement;

  private lobbyCode!: HTMLElement;
  private lobbyCopyBtn!: HTMLButtonElement;
  private lobbyRoster!: HTMLElement;
  private lobbyBotSlider!: HTMLInputElement;
  private lobbyBotCount!: HTMLElement;
  private modeControlLobby!: HTMLElement;
  private lobbyBotFillToggle!: HTMLInputElement;
  private lobbyBotFillLabel!: HTMLElement;
  private lobbyBotRow!: HTMLElement;
  private lobbyReadyBtn!: HTMLButtonElement;
  private lobbyStartBtn!: HTMLButtonElement;
  private lobbyLeaveBtn!: HTMLButtonElement;
  private lobbyStatusEl!: HTMLElement;

  private queueStatusLine!: HTMLElement;
  private queueDetailLine!: HTMLElement;
  private queueProgressBar!: HTMLElement;
  private queueCancelBtn!: HTMLButtonElement;

  private endmatchScreen!: HTMLElement;
  private endmatchTitle!: HTMLElement;
  private endmatchSubtitle!: HTMLElement;
  private endmatchBoard!: HTMLElement;
  private endmatchReturnBtn!: HTMLButtonElement;
  private endmatchPlayAgainBtn!: HTMLButtonElement;

  private latestStats: PlayerStatsRecord | null = null;
  private nameSubmitted = false;
  private statusTimer: number | null = null;
  private matchStartWatchdog: number | null = null;
  private startingSolo = false;
  private startingLobby = false;
  /** When set, auto-join this party as soon as we have a name+welcome. Sourced from `?party=` URL. */
  private pendingPartyJoin: string | null = null;
  /** Last match's party code (null for solo/queue) — controls whether the Play Again button shows. */
  private lastMatchPartyCode: string | null = null;
  /** The mode the picker is on. Drives the public queue, the solo voyage and —
   *  when this pirate wears the crown — the party's own mode (PLAN 2.2). */
  private selectedMode: ModeId = 'solo';
  /** Am I the host of the party the last lobby_update described? */
  private isPartyHost = false;
  /** My own ready tick, mirrored so the button can read as a toggle. */
  private selfReady = false;
  /** The mode the picker was on when "Create Private Party" was pressed. The
   *  server creates every party in Solo, so without this the picker silently
   *  lied: you chose Duos, got a party, and the panel snapped back to Solo. */
  private pendingPartyMode: ModeId | null = null;

  constructor(opts: MenuControllerOptions) {
    this.network = opts.network;
    this.audio = opts.audio;
    this.inputMgr = opts.input ?? null;
    this.onMatchStartCb = opts.onMatchStart;
    this.onReturnToMenuCb = opts.onReturnToMenu ?? null;
    this.onCrewFoundCb = opts.onCrewFound ?? null;
    this.getGovernorStatusCb = opts.getGovernorStatus ?? null;
  }

  init(): void {
    this.screen = this.must('menu-screen');
    this.panelMain = this.must('menu-panel-main');
    this.panelLobby = this.must('menu-panel-lobby');
    this.panelQueue = this.must('menu-panel-queue');
    this.nameInput = this.must<HTMLInputElement>('menu-name-input');
    this.playBtn = this.must<HTMLButtonElement>('menu-play-btn');
    this.soloBtn = this.must<HTMLButtonElement>('menu-solo-btn');
    this.createPartyBtn = this.must<HTMLButtonElement>('menu-create-party-btn');
    this.must('menu-join-party-row'); // presence assertion: the join row is no longer toggled
    this.modeControlMain = this.must('menu-mode-control');
    this.joinCodeInput = this.must<HTMLInputElement>('menu-join-code-input');
    this.joinConfirmBtn = this.must<HTMLButtonElement>('menu-join-confirm-btn');
    this.menuStatus = this.must('menu-status');
    this.statsMatches = this.must('stats-matches');
    this.statsWins = this.must('stats-wins');
    this.statsKills = this.must('stats-kills');
    this.statsDeaths = this.must('stats-deaths');
    this.statsGold = this.must('stats-gold');
    this.statsBest = this.must('stats-best');
    this.statsBtn = this.must<HTMLButtonElement>('menu-stats-btn');
    this.statsBackdrop = this.must('stats-backdrop');
    this.statsPanelName = this.must('stats-panel-name');
    this.statsPanelBody = this.must('stats-panel-body');
    this.statsCloseBtn = this.must<HTMLButtonElement>('stats-close-btn');

    this.lobbyCode = this.must('lobby-code');
    this.lobbyCopyBtn = this.must<HTMLButtonElement>('lobby-copy-btn');
    this.lobbyRoster = this.must('lobby-roster');
    this.lobbyBotSlider = this.must<HTMLInputElement>('lobby-bot-slider');
    // The slider's ceiling is the mode's fleet less the host's own crew, read
    // from MODES — it was the literal 9 in index.html against a fleet the
    // server now builds twelve hulls deep (netcode-17 / DEADTYPES).
    this.lobbyBotSlider.max = String(botFillFor(this.selectedMode, 1));
    this.lobbyBotCount = this.must('lobby-bot-count');
    this.lobbyBotRow = this.must('lobby-bot-row');
    this.lobbyBotFillToggle = this.must<HTMLInputElement>('lobby-botfill-toggle');
    this.lobbyBotFillLabel = this.must('lobby-botfill-label');
    this.modeControlLobby = this.must('lobby-mode-control');
    this.lobbyReadyBtn = this.must<HTMLButtonElement>('lobby-ready-btn');
    this.lobbyStartBtn = this.must<HTMLButtonElement>('lobby-start-btn');
    this.lobbyLeaveBtn = this.must<HTMLButtonElement>('lobby-leave-btn');
    this.lobbyStatusEl = this.must('lobby-status');

    this.queueStatusLine = this.must('queue-status-line');
    this.queueDetailLine = this.must('queue-detail-line');
    this.queueProgressBar = this.must('queue-progress-bar');
    this.queueCancelBtn = this.must<HTMLButtonElement>('queue-cancel-btn');

    this.panelSettings = this.must('menu-panel-settings');
    this.panelHowto = this.must('menu-panel-howto');
    this.howtoBtn = this.must<HTMLButtonElement>('menu-howto-btn');
    this.howtoBackBtn = this.must<HTMLButtonElement>('howto-back-btn');
    this.howtoControls = this.must('howto-controls');
    this.mirrorLegendIntoHowto();
    this.settingsBtn = this.must<HTMLButtonElement>('menu-settings-btn');
    this.settingsBackBtn = this.must<HTMLButtonElement>('settings-back-btn');
    this.settingsVolumeSlider = this.must<HTMLInputElement>('settings-volume');
    this.settingsVolumeVal = this.must('settings-volume-val');
    this.settingsMuteCheckbox = this.must<HTMLInputElement>('settings-mute');
    this.settingsSensSlider = this.must<HTMLInputElement>('settings-sensitivity');
    this.settingsSensVal = this.must('settings-sensitivity-val');
    this.settingsQualitySelect = this.must<HTMLSelectElement>('settings-quality');
    this.settingsQualityNote = this.must('settings-quality-note');

    this.endmatchScreen = this.must('endmatch-screen');
    this.endmatchTitle = this.must('endmatch-title');
    this.endmatchSubtitle = this.must('endmatch-subtitle');
    this.endmatchBoard = this.must('endmatch-board');
    this.endmatchReturnBtn = this.must<HTMLButtonElement>('endmatch-return-btn');
    this.endmatchPlayAgainBtn = this.must<HTMLButtonElement>('endmatch-play-again-btn');

    this.buildModeControl(this.modeControlMain, false);
    this.buildModeControl(this.modeControlLobby, true);
    this.bindUi();
    this.bindNetwork();
    this.applyPersistedSettings();

    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) this.nameInput.value = stored;

    // ?party=CODE deep-link → auto-join once we have a name + welcome.
    try {
      const params = new URLSearchParams(window.location.search);
      // SIX, not four (netcode-23). `.slice(0, 4)` here cut every invite link
      // the shipped server issues down to its first four characters and then
      // dropped it on the floor for not being four long — the deep link was
      // dead for every code created since lane 2.3.
      const raw = normalisePartyCode(params.get('party') ?? '');
      if (isPartyCode(raw)) {
        this.pendingPartyJoin = raw;
        this.flashStatus(`Crew invite ${raw} — enter your pirate name to join.`, false);
      }
      // Strip the param so refreshes don't re-fire and so a copied URL stays clean post-join.
      if (params.has('party')) {
        params.delete('party');
        const search = params.toString();
        const newUrl = window.location.pathname + (search ? `?${search}` : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    } catch { /* SSR / no window — ignore */ }
  }

  /** Called by Game.ts when match_start arrives, so we know whether to offer Play Again with Crew. */
  setLastMatchPartyCode(code: string | null): void {
    this.lastMatchPartyCode = code;
  }

  private must<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id) as T | null;
    if (!el) throw new Error(`menu element missing: #${id}`);
    return el;
  }

  show(): void {
    this.screen.classList.add('visible');
    this.endmatchScreen.classList.remove('visible');
    this.showPanel('main');
    // The menu is no longer silent: the concertina air arms itself here and
    // starts on the first gesture (SoundEngine defers until the context runs).
    this.audio.setMusicContext('menu');
    this.refreshButtonStates();
  }

  hide(): void {
    this.screen.classList.remove('visible');
    // The stats modal is a top-level overlay ABOVE the game HUD — a match
    // starting while it's open (queue pops mid-browse) would leave it covering
    // the spawn. Menu gone ⇒ modal gone.
    this.closeStatsPanel();
    // …and no menu panel may stay on the stack, or the first in-match Escape
    // would be eaten by a panel that is display:none (hud-22).
    modalStack.notifyClosed('menu-panel-settings');
    modalStack.notifyClosed('menu-panel-howto');
    // Drop focus from any menu input/button so keydown WASD lands on document, not the input/button.
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  /**
   * THE RESULTS TABLE IS THE WHOLE FLEET, AND IT IS THE ONLY CARD ON SCREEN.
   *
   * Two things were wrong with the end of a match. The board was built from the
   * server's `humans` list, so a solo queue against nine bots ended on a
   * "results table" with exactly ONE row in it — your own, placement 1, whether
   * you won or drowned in the first minute. And the DEFEATED card arrived at
   * z-index 800 on top of a SHIP SUNK card still sitting at 500, each with its
   * own RETURN TO PORT button, one of them unclickable behind the other.
   *
   * So: the rows are every crew the match was played with, bots included,
   * ranked once by the server; the standing line says where you came out of how
   * many; and opening this screen is what CLOSES the elimination card. One card
   * at a time, one button on it.
   */
  showEndmatch(opts: {
    isWinner: boolean;
    title: string;
    subtitle: string;
    /** "Place: #6 of 10" — printed above the board, in gold when you took it. */
    standing?: string;
    rows: Array<{
      placement: number; name: string; kills: number; deaths: number; gold: number;
      you: boolean; winner: boolean; bot?: boolean; alive?: boolean;
    }>;
  }): void {
    // ONE END SCREEN. The elimination card is a wait-for-the-round card; the
    // round is over, so it goes — along with the body class that was hiding the
    // HUD behind it.
    document.getElementById('death-screen')?.classList.remove('visible');
    const death = document.getElementById('death-screen');
    if (death) death.style.display = 'none';
    const win = document.getElementById('win-screen');
    win?.classList.remove('visible');
    if (win) win.style.display = 'none';
    document.body.classList.remove('showing-death-screen');

    this.endmatchTitle.textContent = opts.title;
    this.endmatchTitle.classList.toggle('defeat', !opts.isWinner);
    this.endmatchSubtitle.textContent = opts.subtitle;
    this.endmatchPlayAgainBtn.style.display = this.lastMatchPartyCode ? '' : 'none';
    this.endmatchBoard.innerHTML = '';

    const standingEl = document.getElementById('endmatch-standing');
    if (standingEl) {
      standingEl.textContent = opts.standing ?? '';
      standingEl.style.display = opts.standing ? '' : 'none';
      standingEl.classList.toggle('won', opts.isWinner);
    }

    const header = document.createElement('div');
    header.className = 'board-row head';
    header.innerHTML = `
      <span class="pl label">#</span>
      <span class="nm label">Crew</span>
      <span class="col label">Kills</span>
      <span class="col label">Deaths</span>
      <span class="col label">Gold</span>
    `;
    this.endmatchBoard.appendChild(header);

    for (const row of opts.rows) {
      const div = document.createElement('div');
      div.className = 'board-row'
        + (row.you ? ' you' : '')
        + (row.winner ? ' winner' : '')
        + (row.alive === false ? ' sunk' : '');
      // A bot crew is named as one — the auditor could not tell which of the
      // ten names on the board were people.
      const tag = row.you ? '<span class="tag you-tag">YOU</span>'
        : row.bot ? '<span class="tag">BOT</span>'
          : '';
      div.innerHTML = `
        <span class="pl">${row.placement}</span>
        <span class="nm">${escapeHtml(row.name)}${row.winner ? ' ★' : ''}${tag}</span>
        <span class="col">${row.kills}</span>
        <span class="col">${row.deaths}</span>
        <span class="col">${row.gold}</span>
      `;
      this.endmatchBoard.appendChild(div);
    }
    this.endmatchScreen.classList.add('visible');
  }

  hideEndmatch(): void {
    this.endmatchScreen.classList.remove('visible');
  }

  isVisible(): boolean {
    return this.screen.classList.contains('visible');
  }

  // ─── UI bindings ─────────────────────────────────────────────
  private bindUi(): void {
    const submitName = (autoName = false) => {
      let name = this.nameInput.value.trim();
      if (!name && autoName) {
        name = `Pirate${Math.floor(1000 + Math.random() * 9000)}`;
        this.nameInput.value = name;
      }
      if (!name) {
        this.flashStatus('Enter a pirate name first.', true);
        return false;
      }
      localStorage.setItem(STORAGE_KEY, name);
      this.network.setName(name);
      this.nameSubmitted = true;
      this.consumePendingPartyJoin();
      return true;
    };

    this.nameInput.addEventListener('change', () => submitName());
    this.nameInput.addEventListener('blur', () => submitName());

    this.playBtn.addEventListener('click', () => {
      // Same guard as soloBtn/lobbyStartBtn: queueing while the socket is down
      // showed a fake infinite matchmaking screen (queueJoin silently no-ops).
      if (!this.network.isConnected()) {
        this.flashStatus('Still connecting to the game server. Try again in a second.', true);
        return;
      }
      if (!submitName()) return;
      this.crewFoundFired = false;
      this.network.queueJoin(this.selectedMode);
      this.showPanel('queue');
      this.queueStatusLine.textContent = 'Hoisting sails…';
      // The real count lands with the first queue_update; quote the true target
      // meanwhile (this used to flash "0 / 8" at a 10-pirate queue).
      this.queueDetailLine.textContent = `— / ${MATCH_TOTAL_SHIPS} pirates · 15s`;
      this.queueProgressBar.style.width = '0%';
    });

    this.soloBtn.addEventListener('click', () => {
      if (this.startingSolo || this.startingLobby) return;
      if (!this.network.isConnected()) {
        this.flashStatus('Still connecting to the game server. Try again in a second.', true);
        return;
      }
      if (!submitName(true)) return;
      this.beginMatchStart('solo');
      // A solo voyage is Solo's fleet whatever the picker says: the ladder's
      // other modes need a crew, and a lone pirate pressing "Sail With Bots"
      // in Duos would otherwise get a brigantine with one hand aboard.
      this.network.soloStart(botFillFor('solo', 1));
    });

    this.createPartyBtn.addEventListener('click', () => {
      if (!submitName()) return;
      this.pendingPartyMode = this.selectedMode;
      this.network.createParty();
    });

    // The field is always on screen now (PLAN 2.2) — there is no toggle to
    // bind. Paste tolerance lives in normalisePartyCode: an invite URL, a code
    // with a dash in it and a lowercase code all resolve.
    this.joinCodeInput.addEventListener('input', () => {
      this.joinCodeInput.value = normalisePartyCode(this.joinCodeInput.value);
    });

    const submitJoin = () => {
      if (!submitName()) return;
      const code = normalisePartyCode(this.joinCodeInput.value);
      if (!isPartyCode(code)) {
        this.flashStatus('A crew code is 6 characters.', true);
        return;
      }
      this.network.joinParty(code);
    };
    this.joinConfirmBtn.addEventListener('click', submitJoin);
    this.joinCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitJoin();
    });

    // Lobby — copy a full invite URL so friends can one-click join.
    this.lobbyCopyBtn.addEventListener('click', () => {
      const code = this.lobbyCode.textContent ?? '';
      if (!code || code === '----') return;
      const url = this.buildInviteUrl(code);
      void navigator.clipboard?.writeText(url).catch(() => {});
      this.lobbyCopyBtn.textContent = 'Copied!';
      window.setTimeout(() => { this.lobbyCopyBtn.textContent = 'Copy Link'; }, 1200);
    });

    this.lobbyBotSlider.addEventListener('input', () => {
      this.lobbyBotCount.textContent = String(this.lobbyBotSlider.value);
    });
    this.lobbyBotSlider.addEventListener('change', () => {
      const value = Number(this.lobbyBotSlider.value);
      this.network.updatePartySettings({ botFill: value });
    });

    // FILL WITH BOTS / REAL PLAYERS ONLY (PLAN 2.2). The slider alone could
    // express "no bots" only by being dragged to zero, which reads as a broken
    // slider rather than a choice. Unticking it sends botFill 0 and parks the
    // slider; ticking it restores the mode's full fleet.
    this.lobbyBotFillToggle.addEventListener('change', () => {
      const on = this.lobbyBotFillToggle.checked;
      this.network.updatePartySettings({ botFill: on ? botFillFor(this.selectedMode, 1) : 0 });
    });

    // READY TICK (netcode-14). The server has taken party_ready since lane 2.3
    // and nothing ever sent one, so `canStart` could only ever come true by the
    // host's 10 s force window.
    this.lobbyReadyBtn.addEventListener('click', () => {
      this.selfReady = !this.selfReady;
      this.network.partyReady(this.selfReady);
      this.paintReadyBtn();
    });

    this.lobbyStartBtn.addEventListener('click', () => {
      if (this.startingSolo || this.startingLobby) return;
      if (!this.network.isConnected()) {
        this.lobbyStatusEl.textContent = 'Still connecting to the game server. Try again in a second.';
        return;
      }
      this.beginMatchStart('lobby');
      this.network.startMatch();
    });

    this.lobbyLeaveBtn.addEventListener('click', () => {
      this.network.leaveParty();
    });

    // Queue
    this.queueCancelBtn.addEventListener('click', () => {
      this.crewFoundFired = false;
      this.network.queueLeave();
      this.showPanel('main');
    });

    // Lifetime stats modal. Escape used to be a `document` listener of this
    // panel's own, firing whether or not the panel was the top thing on screen;
    // it goes through the one stack now (hud-22).
    installModalStack();
    this.statsBtn.addEventListener('click', () => this.openStatsPanel());
    this.statsCloseBtn.addEventListener('click', () => this.closeStatsPanel());
    this.statsBackdrop.addEventListener('click', (e) => {
      if (e.target === this.statsBackdrop) this.closeStatsPanel();
    });

    // How to Play
    this.howtoBtn.addEventListener('click', () => this.showPanel('howto'));
    this.howtoBackBtn.addEventListener('click', () => this.showPanel('main'));
    // …and the three-card tour, from the one screen a player reads BEFORE the
    // horn. The cards used to be a once-per-browser event with no way back.
    document.getElementById('howto-cards-btn')?.addEventListener('click', () => openOnboardingCards());

    // Settings
    this.settingsBtn.addEventListener('click', () => this.showPanel('settings'));
    this.settingsBackBtn.addEventListener('click', () => this.showPanel('main'));

    this.settingsVolumeSlider.addEventListener('input', () => {
      const pct = Number(this.settingsVolumeSlider.value);
      const v = pct / 100;
      this.settingsVolumeVal.textContent = String(pct);
      this.audio.unlock();
      this.audio.setVolume(v);
      this.persistSettings({ volume: v });
    });

    this.settingsMuteCheckbox.addEventListener('change', () => {
      const muted = this.settingsMuteCheckbox.checked;
      this.audio.setMuted(muted);
      this.persistSettings({ muted });
    });

    this.settingsSensSlider.addEventListener('input', () => {
      const pct = Number(this.settingsSensSlider.value);
      const sens = pct / 100;
      this.settingsSensVal.textContent = sens.toFixed(2) + '×';
      this.inputMgr?.setSensitivity(sens);
      this.persistSettings({ sensitivity: sens });
    });

    // GRAPHICS TIER. The renderer reads this at construction, so a change here
    // lands on the next load rather than this one — say so, plainly, instead of
    // letting the player toggle it and conclude nothing happened. Choosing a
    // tier explicitly also clears the audition's remembered ceiling: the player
    // has overruled the detector, and a floor left behind would keep overruling
    // them back.
    this.settingsQualitySelect.addEventListener('change', () => {
      const value = this.settingsQualitySelect.value as QualityPreference;
      saveQualityPreference(value);
      if (value !== 'auto') saveAutoTierCeiling(null);
      this.renderQualityNote(true);
    });

    // End match
    this.endmatchReturnBtn.addEventListener('click', () => {
      this.network.returnToMenu();
      this.hideEndmatch();
      this.onReturnToMenuCb?.();
      this.show();
    });

    this.endmatchPlayAgainBtn.addEventListener('click', () => {
      this.network.playAgain();
      this.hideEndmatch();
      this.onReturnToMenuCb?.();
      // Open the menu — server will push a lobby_update that flips us to the lobby panel.
      this.show();
      this.flashStatus('Reassembling crew…', false);
    });
  }

  // ─── Network bindings ────────────────────────────────────────
  private bindNetwork(): void {
    this.network.onWelcome = (payload: WelcomePayload) => {
      // Auto-set name on connect if we have one stored.
      const stored = localStorage.getItem(STORAGE_KEY) ?? '';
      if (stored && !this.nameSubmitted) {
        this.nameInput.value = stored;
        this.network.setName(stored);
        this.nameSubmitted = true;
        this.consumePendingPartyJoin();
      }
      if (payload.stats) this.applyStats(payload.stats);
    };

    this.network.onStatsUpdate = (stats) => this.applyStats(stats);

    this.network.onLobbyUpdate = (payload) => {
      this.renderLobby(payload);
      this.showPanel('lobby');
    };

    this.network.onLobbyLeft = () => {
      // If we're not in a match, return to main.
      if (this.isVisible()) this.showPanel('main');
    };

    this.network.onLobbyError = (reason) => {
      this.clearMatchStartState();
      this.flashStatus(reason, true);
      this.lobbyStatusEl.textContent = reason;
    };

    this.network.onQueueUpdate = (payload) => {
      this.renderQueue(payload);
    };

    // THE CREW SURVIVES THE MATCH (netcode-04, PLAN 2.2): an automatic exit
    // from a match (end-screen timeout, reaped match) lands the member back in
    // the PARTY panel, never the main menu. The server's lobby_update that
    // follows draws the roster; this just brings the menu up and says why.
    // (Lane 3.5 crew-ui replaces the status line with the full party panel.)
    this.network.onMatchDetached = (payload) => {
      this.clearMatchStartState();
      this.hideEndmatch();
      this.onReturnToMenuCb?.();
      this.show();
      if (payload.code) {
        this.flashStatus(`Back with your crew (${payload.code}).`, false);
        this.showPanel('lobby');
      } else {
        this.flashStatus('The match let you go. Your crew has disbanded.', false);
      }
    };

    // A DEEP LINK WAITS WHILE THE CREW IS AT SEA (netcode-16, PLAN 2.2): the
    // code that was refused with "at sea" is joinable again — join it now,
    // unless the pirate has since found another crew.
    this.network.onPartyAvailable = (payload) => {
      if (!this.isVisible() || this.panelLobby.classList.contains('visible')) return;
      this.flashStatus(`Crew ${payload.code} is back in port — joining.`, false);
      this.network.joinParty(payload.code);
    };

    this.network.onMatchStart = (payload) => {
      this.clearMatchStartState();
      this.hide();
      this.hideEndmatch();
      this.onMatchStartCb(payload);
    };

    this.network.onConnectionClosed = () => {
      this.clearMatchStartState();
      this.flashStatus('Disconnected from server.', true);
      // Mid-match the menu (and its status line) is display:none, so a socket
      // drop was a SILENT permanent freeze — last snapshot kept rendering, HUD
      // up, inputs dropped. Surface an unmissable overlay with the only real
      // recovery (there is no reconnect flow; the server removes the player
      // immediately on disconnect).
      if (!this.isVisible()) this.showDisconnectOverlay('Reconnecting to the server', 'Your seat is held for a minute, pirate. Hold fast.', false);
    };
    // RECON-01 (netcode-31): the recovery UI is no longer a Reload button.
    this.network.onReconnecting = (attempt, nextInMs) => {
      if (this.isVisible()) { this.flashStatus(`Server waking up… retrying (${attempt})`, false); return; }
      this.showDisconnectOverlay('Reconnecting to the server',
        `Attempt ${attempt} — next try in ${Math.round(nextInMs / 100) / 10}s. Your seat is held for a minute.`, false);
    };
    this.network.onResumed = () => {
      // Back aboard: the `join` that follows rebuilds the scene, so the only
      // thing to undo here is the overlay.
      this.dismissDisconnectOverlay();
      this.flashStatus('Back aboard.', false);
    };
    this.network.onResumeFailed = (payload) => {
      const stale = payload.reason === 'stale_client';
      this.showDisconnectOverlay(
        stale ? 'The game was updated' : 'Lost connection to the server',
        stale
          ? 'A new version is out. Reload to set sail again.'
          : 'The match went on without you, pirate. Reload to set sail again.',
        true,
      );
    };
  }

  /** One overlay, two states: "reconnecting" (no button, it is still trying)
   *  and "gone" (a Reload button, the only recovery left). Re-entrant: a later
   *  call rewrites the text in place rather than stacking a second overlay. */
  private showDisconnectOverlay(titleText: string, subText: string, offerReload: boolean): void {
    let overlay = document.getElementById('disconnect-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'disconnect-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:rgba(8,10,14,0.82);color:#f3e7c8;font-family:inherit;text-align:center;';
      const title = document.createElement('div');
      title.id = 'disconnect-title';
      title.style.cssText = 'font-size:28px;letter-spacing:0.06em;';
      const sub = document.createElement('div');
      sub.id = 'disconnect-sub';
      sub.style.cssText = 'font-size:15px;opacity:0.8;';
      overlay.append(title, sub);
      document.body.appendChild(overlay);
      document.exitPointerLock?.();
    }
    const title = document.getElementById('disconnect-title');
    const sub = document.getElementById('disconnect-sub');
    if (title) title.textContent = titleText;
    if (sub) sub.textContent = subText;
    if (offerReload && !document.getElementById('disconnect-reload')) {
      const btn = document.createElement('button');
      btn.id = 'disconnect-reload';
      btn.textContent = 'Reload';
      btn.style.cssText = 'padding:10px 34px;font-size:17px;cursor:pointer;background:#c8a24a;border:none;border-radius:4px;color:#1c1408;';
      btn.onclick = () => window.location.reload();
      overlay.appendChild(btn);
    }
  }

  private dismissDisconnectOverlay(): void {
    document.getElementById('disconnect-overlay')?.remove();
  }

  // ─── Render helpers ──────────────────────────────────────────
  private showPanel(which: MenuPanel): void {
    // ESCAPE AND ENTER BOTH MEAN BACK on the two panels that have a Back
    // button (hud-22). Registered as they open, dropped as they close, so the
    // stack never holds a panel that is not on screen.
    if (which === 'settings' || which === 'howto') {
      const back = () => this.showPanel('main');
      modalStack.open({ id: `menu-panel-${which}`, close: back, confirm: back });
    } else {
      modalStack.notifyClosed('menu-panel-settings');
      modalStack.notifyClosed('menu-panel-howto');
    }
    this.panelMain.classList.toggle('visible', which === 'main');
    this.panelLobby.classList.toggle('visible', which === 'lobby');
    this.panelQueue.classList.toggle('visible', which === 'queue');
    this.panelSettings.classList.toggle('visible', which === 'settings');
    this.panelHowto.classList.toggle('visible', which === 'howto');
    this.setGovernorPolling(which === 'settings');
  }

  /** The graphics line is LIVE while the panel is open: the governor moves on
   *  its own, and a settings screen that prints a stale answer to "what am I
   *  running" is worse than one that prints none. Half a second is well under
   *  the fastest step this controller can take. */
  private setGovernorPolling(on: boolean): void {
    if (on && this.governorPollTimer === null && this.getGovernorStatusCb) {
      this.governorPollTimer = window.setInterval(() => this.renderQualityNote(false), 500);
    } else if (!on && this.governorPollTimer !== null) {
      window.clearInterval(this.governorPollTimer);
      this.governorPollTimer = null;
    }
  }

  /**
   * Copy the in-match legend's body into the How to Play panel.
   *
   * ONE source of truth, on purpose: a second hand-written controls list is a
   * list that goes stale the first time a key moves. The legend card
   * (#legend-body) is the canonical one — it is what [L] shows mid-voyage — and
   * the menu simply mirrors its markup.
   */
  private mirrorLegendIntoHowto(): void {
    const legendBody = document.getElementById('legend-body');
    if (!legendBody) return;
    const clone = legendBody.cloneNode(true) as HTMLElement;
    // The panel states the win condition in its own banner above — the legend's
    // copy of it would be the same sentence twice on one screen.
    for (const dupe of clone.querySelectorAll('.legend-win')) dupe.remove();
    this.howtoControls.innerHTML = clone.innerHTML;
  }

  private loadSettings(): PersistedSettings {
    const fallback: PersistedSettings = { volume: 0.55, muted: false, sensitivity: 1.0 };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      return {
        volume: typeof parsed.volume === 'number' ? clamp01(parsed.volume) : fallback.volume,
        muted: !!parsed.muted,
        sensitivity: typeof parsed.sensitivity === 'number'
          ? Math.max(0.2, Math.min(2.0, parsed.sensitivity))
          : fallback.sensitivity,
      };
    } catch { return fallback; }
  }

  private persistSettings(patch: Partial<PersistedSettings>): void {
    const merged = { ...this.loadSettings(), ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged)); } catch {}
  }

  /** What Auto decided and why — and, once the player changes it, that the new
   *  tier takes effect on the next load. */
  /** The verdict as it was when the page LOADED — which is the tier the renderer
   *  actually built itself with. Re-deciding after the player picks a new one
   *  would report the choice back to them as if it were already running. */
  private readonly bootQualityVerdict = decideRenderQuality();

  /**
   * WHAT IT IS ACTUALLY RUNNING, not what it was asked for.
   *
   * Two different facts, and this panel used to conflate them. The TIER is a
   * startup decision — it decides the material set every island was built with,
   * so changing it lands on the next load. The QUALITY the machine is running
   * right now is the frame governor's, it moves during play, and the player had
   * no way at all to see it: a session that had walked its resolution down to
   * 0.44 and its shadow map to 1024 still printed "Running: low — detected
   * hardware", which was true and useless.
   *
   * So the line is now two sentences. The first is live. The second says who
   * chose the tier and, if it was the player, that their choice is a CEILING
   * the governor may still protect the floor under — because it will, and a
   * player who has pinned 'high' and watches the resolution move deserves to
   * have been told that rather than to discover it.
   */
  private renderQualityNote(justChanged: boolean): void {
    const verdict = this.bootQualityVerdict;
    const tierLabel = renderQualityLabel(verdict.quality);
    const why: Record<string, string> = {
      player: 'your choice',
      url: 'set by ?quality=',
      'air-class-gpu': `${verdict.rendererString ?? 'Apple silicon'} — Air class, no fan to spare`,
      'thin-laptop': 'a HiDPI panel on a modest core count',
      'few-cores': 'few CPU cores',
      'low-memory': 'limited device memory',
      'huge-viewport': 'a very large window on a modest machine',
      audition: 'this machine could not hold a higher tier last session',
      default: 'detected hardware',
    };
    const detail = why[verdict.reason] ?? 'detected hardware';
    const status = this.getGovernorStatusCb?.() ?? null;
    const pinned = this.settingsQualitySelect.value !== 'auto';

    const lines: string[] = [];
    if (status) {
      lines.push(`Now running: ${status.label}.`);
      if (status.mode === 'floor') {
        lines.push('This machine could not hold 60fps with every setting spent, '
          + 'so it is holding a steady 30 rather than degrading further.');
      }
    }
    if (justChanged) {
      const selected = this.settingsQualitySelect.value === 'balanced'
        ? 'Medium'
        : this.settingsQualitySelect.selectedOptions[0]?.textContent?.split(' — ')[0] ?? 'the selected tier';
      lines.push(`${selected} is saved. Reload the game to apply it (still on ${tierLabel} — ${detail}).`);
    } else if (!status) {
      lines.push(`Tier: ${tierLabel} — ${detail}.`);
    } else {
      lines.push(`Tier: ${tierLabel} — ${detail}.`);
    }
    // THE CLASS CEILING, SAID OUT LOUD (airsafe). A manual High on a fanless
    // M2 Air keeps the High look but has its resolution, shadow map and sample
    // count held to what the part can sustain — and a player who pinned High
    // and sees native resolution and 1536 shadows must have been told rather
    // than left to discover it. On a fresh pick the note describes the tier
    // they just chose, so they know before they reload.
    const justPicked = justChanged ? parseRenderQuality(this.settingsQualitySelect.value) : null;
    const fillCap = justPicked
      ? this.fillCapFor(justPicked)
      : status?.fillCap ?? this.fillCapFor(verdict.quality);
    const capNote = describeFillCap(fillCap, verdict.rendererString);
    if (capNote) lines.push(capNote);
    if (status?.enabled) {
      lines.push(pinned
        ? 'Your choice sets the CEILING. Auto still lowers resolution and detail below it '
          + 'if this machine cannot hold the frame rate — it will never raise them past your tier.'
        : 'Auto measures the frame and spends exactly the budget this machine has: '
          + 'the settings you cannot see go first, resolution last.');
    }
    this.settingsQualityNote.textContent = lines.join(' ');
  }

  /** The class ceiling's report for a tier on THIS machine, from the boot
   *  verdict's GPU name — the same arithmetic the renderer does, so the panel
   *  can describe a tier the player has not loaded yet. */
  private fillCapFor(tier: RenderQuality): FillCapReport {
    const verdict = this.bootQualityVerdict;
    const gpuClass = fillClassFor(classifyRenderer(verdict.rendererString), verdict.reason);
    return fillCapReport(tier, window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, gpuClass, tierShadowMapSize(tier));
  }

  /** "High — maximum detail, capped for this Mac": the option says so before
   *  the player picks it, on a machine where the class ceiling would bind. A
   *  pick from this select is a player pin, so the software rasteriser is
   *  capped here even though a URL pin on it is not. */
  private labelCappedTiers(): void {
    const gpuClass = classifyRenderer(this.bootQualityVerdict.rendererString);
    const device = gpuClass === 'apple-base' || gpuClass === 'apple-opaque' ? 'Mac'
      : gpuClass === 'mobile-gpu' ? 'device' : 'machine';
    for (const option of Array.from(this.settingsQualitySelect.options)) {
      const tier = parseRenderQuality(option.value);
      if (!tier || option.dataset.capLabelled) continue;
      const report = fillCapReport(tier, window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, gpuClass, tierShadowMapSize(tier));
      if (!report.binds) continue;
      option.dataset.capLabelled = '1';
      const base = option.textContent?.split(', ')[0] ?? renderQualityLabel(tier);
      option.textContent = `${base}, capped for this ${device}`;
    }
  }

  private applyPersistedSettings(): void {
    const s = this.loadSettings();
    this.settingsVolumeSlider.value = String(Math.round(s.volume * 100));
    this.settingsVolumeVal.textContent = String(Math.round(s.volume * 100));
    this.settingsMuteCheckbox.checked = s.muted;
    this.settingsSensSlider.value = String(Math.round(s.sensitivity * 100));
    this.settingsSensVal.textContent = s.sensitivity.toFixed(2) + '×';
    this.labelCappedTiers();
    this.settingsQualitySelect.value = loadQualityPreference();
    this.renderQualityNote(false);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.inputMgr?.setSensitivity(s.sensitivity);
  }

  private renderLobby(payload: LobbyUpdatePayload): void {
    this.lobbyCode.textContent = payload.code;
    const isHost = this.network.clientId === payload.hostId;
    this.isPartyHost = isHost;
    if (this.pendingPartyMode && isHost && payload.mode !== this.pendingPartyMode) {
      const want = this.pendingPartyMode;
      this.pendingPartyMode = null;
      this.network.updatePartySettings({ mode: want });
      return; // the echo lands as another lobby_update; draw once, on the truth
    }
    this.pendingPartyMode = null;
    if (isModeId(payload.mode) && payload.mode !== this.selectedMode) {
      this.selectedMode = payload.mode;
      this.paintModeControls();
    }

    const model = partyRosterModel(payload, this.network.clientId ?? '');
    this.selfReady = model.rows.find((r) => r.you)?.ready ?? false;
    this.lobbyRoster.innerHTML = '';
    for (const group of model.groups) {
      const head = document.createElement('div');
      head.className = 'lobby-group-head';
      head.textContent = group.label;
      this.lobbyRoster.appendChild(head);
      for (const row of group.rows) this.lobbyRoster.appendChild(this.buildRosterRow(row));
    }
    if (model.refusal) {
      const warn = document.createElement('div');
      warn.className = 'lobby-refusal';
      warn.textContent = model.refusal;
      this.lobbyRoster.appendChild(warn);
    }

    const fullFill = botFillFor(this.selectedMode, 1);
    this.lobbyBotSlider.max = String(fullFill);
    this.lobbyBotSlider.value = String(Math.min(payload.botFill, fullFill));
    this.lobbyBotCount.textContent = String(payload.botFill);
    this.lobbyBotSlider.disabled = !isHost || payload.botFill === 0;
    this.lobbyBotFillToggle.checked = payload.botFill > 0;
    this.lobbyBotFillToggle.disabled = !isHost;
    this.lobbyBotFillLabel.textContent = payload.botFill > 0 ? 'Fill with bots' : 'Real players only';
    this.lobbyBotRow.style.opacity = payload.botFill > 0 ? '1' : '0.45';

    this.paintReadyBtn();
    this.lobbyStartBtn.disabled = this.startingLobby || !isHost || !payload.canStart || !!model.refusal;
    this.lobbyStartBtn.style.opacity = isHost ? '1' : '0.55';
    this.lobbyStartBtn.textContent = payload.inMatch ? '⛵ Crew At Sea' : '⛵ Start Voyage';
    if (model.refusal) this.lobbyStatusEl.textContent = model.refusal;
    else if (payload.membersAtSea.length > 0) {
      this.lobbyStatusEl.textContent = `${payload.membersAtSea.length} still at sea — the voyage waits for them.`;
    } else if (!isHost) this.lobbyStatusEl.textContent = 'The captain casts off.';
    else this.lobbyStatusEl.textContent = payload.canStart ? '' : 'Waiting on the crew to ready up.';
  }

  /** ONE roster row: ready tick, name, crown, and the host's two controls. */
  private buildRosterRow(row: PartyRosterRow): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lobby-member'
      + (row.isHost ? ' host' : '')
      + (row.atSea ? ' at-sea' : '')
      + (row.overflow ? ' overflow' : '');
    const who = document.createElement('div');
    who.className = 'who';
    const tick = document.createElement('span');
    tick.className = 'tick' + (row.ready ? '' : ' waiting');
    tick.textContent = row.ready ? '✔' : '○';
    tick.title = row.ready ? 'Ready' : 'Not ready';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = row.name + (row.you ? ' (you)' : '');
    who.append(tick, nm);
    if (row.isHost) {
      const crown = document.createElement('span');
      crown.className = 'role-pill';
      crown.textContent = '👑 Captain';
      who.appendChild(crown);
    }
    if (row.atSea) {
      const pill = document.createElement('span');
      pill.className = 'role-pill';
      pill.textContent = 'At sea';
      who.appendChild(pill);
    }
    el.appendChild(who);

    const acts = document.createElement('div');
    acts.className = 'acts';
    if (row.crownable) {
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = 'Make captain';
      btn.addEventListener('click', () => this.network.partyTransferHost(row.clientId));
      acts.appendChild(btn);
    }
    if (row.kickable) {
      const btn = document.createElement('button');
      btn.className = 'mini danger';
      btn.textContent = 'Kick';
      btn.addEventListener('click', () => this.network.partyKick(row.clientId));
      acts.appendChild(btn);
    }
    el.appendChild(acts);
    return el;
  }

  private paintReadyBtn(): void {
    this.lobbyReadyBtn.textContent = this.selfReady ? '✔ Ready' : 'Ready';
    this.lobbyReadyBtn.classList.toggle('primary', this.selfReady);
  }

  /**
   * THE MODE PICKER (PLAN 2.2 / MODE-01).
   *
   * Rendered twice from one table: on the main menu (it chooses what the public
   * queue and the party you create are for) and inside the party panel (where
   * only the captain may move it). Squads renders disabled straight off
   * `MODES.squads.available` — the snapshot ceiling is real until WIRE-01, and
   * a mode you can pick and then be refused for is worse than one greyed out
   * with the reason on it.
   */
  private buildModeControl(host: HTMLElement, partyScoped: boolean): void {
    host.innerHTML = '';
    for (const id of MODE_IDS) {
      const spec = MODES[id];
      const btn = document.createElement('button');
      btn.className = 'mode-opt';
      btn.type = 'button';
      btn.dataset.mode = id;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(id === this.selectedMode));
      btn.innerHTML = `${escapeHtml(spec.label)}<span class="sub">${spec.crewSize} · ${spec.crews} ships</span>`;
      if (!spec.available) {
        btn.disabled = true;
        btn.title = 'Not open yet — sails once the crew wire is widened';
      }
      btn.addEventListener('click', () => {
        if (!spec.available) return;
        if (partyScoped && !this.isPartyHost) return;
        this.selectedMode = id;
        this.paintModeControls();
        this.lobbyBotSlider.max = String(botFillFor(id, 1));
        if (partyScoped) this.network.updatePartySettings({ mode: id });
      });
      host.appendChild(btn);
    }
  }

  private paintModeControls(): void {
    for (const host of [this.modeControlMain, this.modeControlLobby]) {
      for (const el of Array.from(host.querySelectorAll<HTMLElement>('.mode-opt'))) {
        el.setAttribute('aria-checked', String(el.dataset.mode === this.selectedMode));
      }
    }
  }

  private renderQueue(payload: QueueUpdatePayload): void {
    if (payload.starting) {
      // The "crew found" beat: the cohort has been pulled out of the queue and
      // is being placed. Hand the moment to the game so the ceremony overlay
      // (found → countdown → horn) starts here instead of at the horn.
      this.queueStatusLine.textContent = 'Crew found — boarding…';
      this.queueProgressBar.style.width = '100%';
      const aboard = payload.inQueue;
      this.queueDetailLine.textContent = `${aboard} pirate${aboard === 1 ? '' : 's'} aboard · weighing anchor`;
      if (!this.crewFoundFired) {
        this.crewFoundFired = true;
        this.onCrewFoundCb?.();
      }
      return;
    }
    if (payload.inQueue >= payload.needed) {
      this.queueStatusLine.textContent = 'Crew complete — setting sail…';
    } else {
      this.queueStatusLine.textContent = 'Searching the Reach for fellow pirates…';
    }
    this.queueDetailLine.textContent = `${payload.inQueue} / ${payload.needed} pirates · ${payload.secondsRemaining}s`;
    const pct = Math.min(100, Math.round((payload.inQueue / payload.needed) * 100));
    this.queueProgressBar.style.width = pct + '%';
  }

  private applyStats(stats: PlayerStatsRecord): void {
    this.latestStats = stats;
    this.statsMatches.textContent = String(stats.matchesPlayed);
    this.statsWins.textContent = String(stats.wins);
    this.statsKills.textContent = String(stats.kills);
    this.statsDeaths.textContent = String(stats.deaths);
    this.statsGold.textContent = String(stats.totalGold);
    this.statsBest.textContent = stats.bestPlacement > 0 ? `#${stats.bestPlacement}` : '—';
    this.statsBtn.style.display = '';
    if (this.statsBackdrop.classList.contains('visible')) this.renderStatsPanel();
  }

  private openStatsPanel(): void {
    if (!this.latestStats) return;
    this.renderStatsPanel();
    this.statsBackdrop.classList.add('visible');
    modalStack.open({ id: 'stats-panel', close: () => this.closeStatsPanel() });
  }

  private closeStatsPanel(): void {
    this.statsBackdrop.classList.remove('visible');
    modalStack.notifyClosed('stats-panel');
  }

  private renderStatsPanel(): void {
    const s = this.latestStats;
    if (!s) return;
    // Records written before the lifetime-stats expansion lack the new fields.
    const n = (v: number | undefined) => v ?? 0;
    this.statsPanelName.textContent = s.name || this.nameInput.value.trim() || 'Unknown Pirate';
    const matches = n(s.matchesPlayed);
    const winRate = matches > 0 ? `${Math.round((n(s.wins) / matches) * 100)}%` : '—';
    const kd = (n(s.kills) / Math.max(1, n(s.deaths))).toFixed(2);
    const section = (title: string, rows: Array<[string, string | number]>) => `
      <div class="stats-section">
        <h3>${title}</h3>
        ${rows.map(([label, val]) => `<div class="stats-line"><span>${label}</span><span class="val">${val}</span></div>`).join('')}
      </div>`;
    this.statsPanelBody.innerHTML =
      section('Voyages', [
        ['Matches', matches],
        ['Wins', n(s.wins)],
        ['Win rate', winRate],
        ['Best placement', n(s.bestPlacement) > 0 ? `#${s.bestPlacement}` : '—'],
      ]) +
      section('Combat', [
        ['Kills', n(s.kills)],
        ['Deaths', n(s.deaths)],
        ['K/D', kd],
        ['Headshots', n(s.headshots)],
        ['Best kill streak', n(s.bestKillStreak)],
        ['Damage dealt', Math.round(n(s.damageDealt))],
      ]) +
      section('Treasure', [
        ['Total gold', n(s.totalGold)],
        ['Best match gold', n(s.bestMatchGold)],
        ['Chests sold', n(s.chestsSold)],
        ['Chests dug', n(s.chestsDug)],
      ]) +
      section('Island Life', [
        ['Wood chopped', n(s.woodChopped)],
        ['Ore mined', n(s.oreMined)],
        ['Sharks killed', n(s.sharksKilled)],
        ['Skeletons killed', n(s.skeletonsKilled)],
      ]) +
      section('Naval', [['Ships sunk', n(s.shipsSunk)]]) +
      section('Time', [['Time played', formatPlayTime(n(s.playSeconds))]]);
  }

  private refreshButtonStates(): void {
    this.soloBtn.disabled = this.startingSolo || this.startingLobby;
    this.playBtn.disabled = this.startingSolo || this.startingLobby;
    this.createPartyBtn.disabled = this.startingSolo || this.startingLobby;
    if (this.startingLobby) this.lobbyStartBtn.disabled = true;
  }

  private beginMatchStart(kind: 'solo' | 'lobby'): void {
    this.clearMatchStartWatchdog();
    this.startingSolo = kind === 'solo';
    this.startingLobby = kind === 'lobby';
    if (kind === 'solo') {
      this.flashStatus('Starting solo bot voyage...', false);
      this.soloBtn.textContent = 'Starting...';
    } else {
      this.lobbyStatusEl.textContent = 'Starting bot voyage...';
      this.lobbyStartBtn.textContent = 'Starting...';
    }
    this.refreshButtonStates();
    this.matchStartWatchdog = window.setTimeout(() => {
      const message = 'Still building the bot match. If this stays here, refresh and make sure the server terminal is running.';
      if (kind === 'solo') this.flashStatus(message, true);
      else this.lobbyStatusEl.textContent = message;
    }, 8000);
  }

  private clearMatchStartWatchdog(): void {
    if (this.matchStartWatchdog !== null) {
      window.clearTimeout(this.matchStartWatchdog);
      this.matchStartWatchdog = null;
    }
  }

  private clearMatchStartState(): void {
    this.clearMatchStartWatchdog();
    this.startingSolo = false;
    this.startingLobby = false;
    this.soloBtn.textContent = '☠ Solo Voyage · Sail With Bots';
    this.lobbyStartBtn.textContent = '⛵ Start Voyage';
    this.lobbyStartBtn.disabled = false;
    this.refreshButtonStates();
  }

  private consumePendingPartyJoin(): void {
    const code = this.pendingPartyJoin;
    if (!code || !this.nameSubmitted) return;
    this.pendingPartyJoin = null;
    this.network.joinParty(code);
  }

  private buildInviteUrl(code: string): string {
    try {
      const u = new URL(window.location.href);
      // Strip any existing party param so we don't double-stack it.
      u.searchParams.delete('party');
      u.searchParams.set('party', code);
      // Drop the hash — friends don't need it.
      u.hash = '';
      return u.toString();
    } catch {
      return code;
    }
  }

  private flashStatus(text: string, isError: boolean): void {
    this.menuStatus.textContent = text;
    this.menuStatus.style.color = isError ? '#ffb09a' : '#9ec0e5';
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.menuStatus.textContent = '';
    }, 4000);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function formatPlayTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

// ─── The party panel's pure model (graded by scripts/test-menu-party-ui.mjs) ──
// Kept out of the class on purpose: none of it touches the DOM, the socket or
// `window`, so the gate can drive it under plain node in 0.3 s instead of
// standing up a stack and a browser to look at a roster.

/** A code as the server issues it: A-Z2-9, six long, four still legal for one
 *  release (PLAN §7 — shared links must not break). Tolerates a pasted URL's
 *  punctuation, a lowercase code and trailing whitespace. */
export function normalisePartyCode(raw: string): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function isPartyCode(code: string): boolean {
  return code.length === 6 || code.length === 4;
}

export interface PartyRosterRow {
  clientId: string;
  name: string;
  isHost: boolean;
  ready: boolean;
  atSea: boolean;
  you: boolean;
  /** Beyond the mode's crew size — this hand has no berth until the mode moves. */
  overflow: boolean;
  kickable: boolean;
  crownable: boolean;
}

export interface PartyRosterGroup {
  /** "Hull 1 · Brigantine · 2 / 2" — the header above the group's rows. */
  label: string;
  hull: string;
  rows: PartyRosterRow[];
}

export interface PartyRosterModel {
  rows: PartyRosterRow[];
  groups: PartyRosterGroup[];
  /** Set when the roster cannot sail this mode, in the server's own words. */
  refusal: string | null;
}

/**
 * THE ROSTER, GROUPED BY THE HULL EACH MEMBER SAILS (hud-21).
 *
 * The panel used to print a flat list of names with a Host pill, in a product
 * whose whole premise is crews: it never said how many berths the chosen mode
 * has, never showed a ready tick (nothing sent `party_ready`, so nothing could),
 * and gave the captain no kick and no way to hand the crown over. It also let a
 * party of three sit in Duos looking perfectly fine until `start_match` refused
 * it at the dock — the refusal is computed here instead, from the same rule the
 * server applies (LobbyServer.handleQueueJoin, PLAN §2.1).
 */
export function partyRosterModel(
  payload: Pick<LobbyUpdatePayload, 'mode' | 'hostId' | 'members' | 'membersAtSea'>,
  selfId: string,
): PartyRosterModel {
  const spec = modeSpec(payload.mode);
  const atSea = new Set(payload.membersAtSea ?? []);
  const iAmHost = payload.hostId === selfId;
  const rows: PartyRosterRow[] = payload.members.map((m, i) => ({
    clientId: m.clientId,
    name: m.name,
    isHost: m.clientId === payload.hostId,
    ready: !!m.ready,
    atSea: !!m.atSea || atSea.has(m.clientId),
    you: m.clientId === selfId,
    overflow: i >= spec.crewSize,
    kickable: iAmHost && m.clientId !== selfId,
    crownable: iAmHost && m.clientId !== selfId,
  }));

  const groups: PartyRosterGroup[] = [];
  const berths = Math.max(1, spec.crewSize);
  for (let start = 0; start < Math.max(rows.length, 1); start += berths) {
    const slice = rows.slice(start, start + berths);
    if (slice.length === 0) break;
    const hullNo = Math.floor(start / berths) + 1;
    groups.push({
      hull: spec.hull,
      label: `Hull ${hullNo} · ${spec.hull} · ${slice.length} / ${berths}`,
      rows: slice,
    });
  }

  let refusal: string | null = null;
  if (rows.length > spec.crewSize) {
    const fits = MODE_IDS.find((m) => MODES[m].available && MODES[m].crewSize >= rows.length);
    refusal = `${spec.label} takes ${spec.crewSize}`
      + (fits ? `; switch to ${MODES[fits].label}` : '; too many hands for any mode');
  }
  return { rows, groups, refusal };
}
