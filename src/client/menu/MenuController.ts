import type {
  LobbyUpdatePayload, QueueUpdatePayload, PlayerStatsRecord, MatchStartPayload, WelcomePayload,
} from '../../shared/types/index.js';
import { MATCH_TOTAL_SHIPS } from '../../shared/constants/index.js';
import type { NetworkClient } from '../network/NetworkClient.js';
import type { SoundEngine } from '../audio/SoundEngine.js';
import type { InputManager } from '../input/InputManager.js';
import { openOnboardingCards } from '../ui/OnboardingCards.js';
import {
  decideRenderQuality, loadQualityPreference, saveAutoTierCeiling, saveQualityPreference,
  type QualityPreference,
} from '../rendering/QualityPreference.js';

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
  private joinPartyToggleBtn!: HTMLButtonElement;
  private joinPartyRow!: HTMLElement;
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
    this.joinPartyToggleBtn = this.must<HTMLButtonElement>('menu-join-party-toggle-btn');
    this.joinPartyRow = this.must('menu-join-party-row');
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
    this.lobbyBotCount = this.must('lobby-bot-count');
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

    this.bindUi();
    this.bindNetwork();
    this.applyPersistedSettings();

    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) this.nameInput.value = stored;

    // ?party=CODE deep-link → auto-join once we have a name + welcome.
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = (params.get('party') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (raw.length === 4) {
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
      this.network.queueJoin();
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
      this.network.soloStart(9);
    });

    this.createPartyBtn.addEventListener('click', () => {
      if (!submitName()) return;
      this.network.createParty();
    });

    this.joinPartyToggleBtn.addEventListener('click', () => {
      const visible = this.joinPartyRow.style.display !== 'none';
      this.joinPartyRow.style.display = visible ? 'none' : 'flex';
      if (!visible) this.joinCodeInput.focus();
    });

    this.joinCodeInput.addEventListener('input', () => {
      this.joinCodeInput.value = this.joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });

    const submitJoin = () => {
      if (!submitName()) return;
      const code = this.joinCodeInput.value.trim().toUpperCase();
      if (code.length !== 4) {
        this.flashStatus('Code must be 4 characters.', true);
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

    // Lifetime stats modal
    this.statsBtn.addEventListener('click', () => this.openStatsPanel());
    this.statsCloseBtn.addEventListener('click', () => this.closeStatsPanel());
    this.statsBackdrop.addEventListener('click', (e) => {
      if (e.target === this.statsBackdrop) this.closeStatsPanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.statsBackdrop.classList.contains('visible')) this.closeStatsPanel();
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
      if (!this.isVisible() && !document.getElementById('disconnect-overlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'disconnect-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:rgba(8,10,14,0.82);color:#f3e7c8;font-family:inherit;text-align:center;';
        const title = document.createElement('div');
        title.textContent = 'Lost connection to the server';
        title.style.cssText = 'font-size:28px;letter-spacing:0.06em;';
        const sub = document.createElement('div');
        sub.textContent = 'The match went on without you, pirate. Reload to set sail again.';
        sub.style.cssText = 'font-size:15px;opacity:0.8;';
        const btn = document.createElement('button');
        btn.textContent = 'Reload';
        btn.style.cssText = 'padding:10px 34px;font-size:17px;cursor:pointer;background:#c8a24a;border:none;border-radius:4px;color:#1c1408;';
        btn.onclick = () => window.location.reload();
        overlay.append(title, sub, btn);
        document.body.appendChild(overlay);
        document.exitPointerLock?.();
      }
    };
  }

  // ─── Render helpers ──────────────────────────────────────────
  private showPanel(which: MenuPanel): void {
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
      lines.push(`Tier takes effect next time you load the game (still on ${verdict.quality} — ${detail}).`);
    } else if (!status) {
      lines.push(`Tier: ${verdict.quality} — ${detail}.`);
    } else {
      lines.push(`Tier: ${verdict.quality} — ${detail}.`);
    }
    if (status?.enabled) {
      lines.push(pinned
        ? 'Your choice sets the CEILING. Auto still lowers resolution and detail below it '
          + 'if this machine cannot hold the frame rate — it will never raise them past your tier.'
        : 'Auto measures the frame and spends exactly the budget this machine has: '
          + 'the settings you cannot see go first, resolution last.');
    }
    this.settingsQualityNote.textContent = lines.join(' ');
  }

  private applyPersistedSettings(): void {
    const s = this.loadSettings();
    this.settingsVolumeSlider.value = String(Math.round(s.volume * 100));
    this.settingsVolumeVal.textContent = String(Math.round(s.volume * 100));
    this.settingsMuteCheckbox.checked = s.muted;
    this.settingsSensSlider.value = String(Math.round(s.sensitivity * 100));
    this.settingsSensVal.textContent = s.sensitivity.toFixed(2) + '×';
    this.settingsQualitySelect.value = loadQualityPreference();
    this.renderQualityNote(false);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.inputMgr?.setSensitivity(s.sensitivity);
  }

  private renderLobby(payload: LobbyUpdatePayload): void {
    this.lobbyCode.textContent = payload.code;
    this.lobbyRoster.innerHTML = '';
    for (const m of payload.members) {
      const el = document.createElement('div');
      el.className = 'lobby-member' + (m.isHost ? ' host' : '');
      el.innerHTML = `
        <span>${escapeHtml(m.name)}</span>
        ${m.isHost ? '<span class="role-pill">Host</span>' : '<span class="role-pill" style="background:rgba(126,172,220,0.16);color:#9ec0e5;">Crew</span>'}
      `;
      this.lobbyRoster.appendChild(el);
    }
    const isHost = this.network.clientId === payload.hostId;
    this.lobbyBotSlider.value = String(payload.botFill);
    this.lobbyBotCount.textContent = String(payload.botFill);
    this.lobbyBotSlider.disabled = !isHost;
    this.lobbyStartBtn.disabled = this.startingLobby || !isHost || !payload.canStart;
    this.lobbyStartBtn.style.opacity = isHost ? '1' : '0.55';
    if (this.startingLobby) {
      this.lobbyStatusEl.textContent = 'Starting bot voyage...';
    } else {
      this.lobbyStatusEl.textContent = isHost
        ? `${payload.members.length} aboard · ${payload.botFill} bot crews will fill out the seas`
        : 'Waiting for the host to start…';
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
  }

  private closeStatsPanel(): void {
    this.statsBackdrop.classList.remove('visible');
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
