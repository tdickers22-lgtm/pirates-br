import type {
  HotSnapshotPayload,
  NetMsg, PlayerInput, GameState, TradeActionPayload,
  WelcomePayload, LobbyUpdatePayload, QueueUpdatePayload, MatchStartPayload,
  PlayerStatsRecord,
} from '../../shared/types/index.js';

export class NetworkClient {
  private ws!: WebSocket;
  private connected = false;
  public clientId: string | null = null;
  public playerId: string | null = null;
  public shipId: string | null = null;
  public matchId: string | null = null;

  // Game-scoped events
  public onSnapshot: ((state: GameState) => void) | null = null;
  public onHotSnapshot: ((hot: HotSnapshotPayload) => void) | null = null;
  public onPlayerDowned: ((payload: { playerId: string; playerName: string; attackerId: string | null; attackerName: string | null }) => void) | null = null;
  public onReviveComplete: ((payload: { playerId: string; playerName: string; reviverId: string | null; reviverName: string | null }) => void) | null = null;
  public onJoin: ((playerId: string, shipId: string, snapshot: GameState) => void) | null = null;
  public onPlayerHit: ((payload: unknown) => void) | null = null;
  public onShipHit: ((payload: unknown) => void) | null = null;
  public onShipDamage: ((payload: unknown) => void) | null = null;
  public onShipImpact: ((payload: unknown) => void) | null = null;
  public onKillEvent: ((payload: unknown) => void) | null = null;
  public onKegExploded: ((payload: unknown) => void) | null = null;
  public onChestOpened: ((payload: unknown) => void) | null = null;
  public onBarrelOpened: ((payload: unknown) => void) | null = null;
  public onShipUpgraded: ((payload: unknown) => void) | null = null;
  public onPropRemoved: ((payload: unknown) => void) | null = null;
  public onTreasureSold: ((payload: unknown) => void) | null = null;
  public onArmorBought: ((payload: unknown) => void) | null = null;
  public onAmmoRefilled: ((payload: unknown) => void) | null = null;
  public onTreasureMap: ((payload: unknown) => void) | null = null;
  public onTradeRequest: ((payload: unknown) => void) | null = null;
  public onTradeUpdate: ((payload: unknown) => void) | null = null;
  public onTradeResult: ((payload: unknown) => void) | null = null;
  public onGameOver: ((payload: unknown) => void) | null = null;
  public onPlayerSpawned: ((payload: unknown) => void) | null = null;
  public onMatchEnded: ((payload: unknown) => void) | null = null;
  /** Staged start: one per whole second while the sim is frozen in 'waiting'. */
  public onMatchCountdown: ((payload: { secondsRemaining: number; totalSeconds: number; crews: number }) => void) | null = null;
  /** Staged start: the sim just went live. */
  public onMatchHorn: ((payload: { crews: number }) => void) | null = null;
  /** A crew's ship went down — CREWS AFLOAT just dropped. */
  public onCrewEliminated: ((payload: {
    crewId: string;
    crewName: string;
    remaining: number;
    byPlayerId: string | null;
    byName: string | null;
  }) => void) | null = null;

  // Lobby-scoped events
  public onWelcome: ((payload: WelcomePayload) => void) | null = null;
  public onLobbyUpdate: ((payload: LobbyUpdatePayload) => void) | null = null;
  public onLobbyLeft: (() => void) | null = null;
  public onLobbyError: ((reason: string) => void) | null = null;
  public onQueueUpdate: ((payload: QueueUpdatePayload) => void) | null = null;
  public onMatchStart: ((payload: MatchStartPayload) => void) | null = null;
  public onStatsUpdate: ((stats: PlayerStatsRecord) => void) | null = null;
  public onConnectionClosed: (() => void) | null = null;

  private pendingSnapshot: GameState | null = null;
  private snapshotFlushQueued = false;

  /**
   * True only between the server's `join` for the current match and the moment
   * we leave it. Match-scoped sends are gated on this.
   *
   * The render/input loop starts as soon as the socket is open (the menu is
   * drawn over a live frame loop), so without this gate the FIRST thing a fresh
   * client puts on the wire is a `player_input` seq 0 — before it has even sent
   * `set_name`, let alone joined a match. The lobby can only drop it, it muddies
   * every trace of the connect sequence, and it hands anything sitting in front
   * of the socket a gameplay frame from a client that has no player. Nothing may
   * be sent on a match channel that does not exist yet.
   */
  private joined = false;

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** True once the join handshake for the current match has completed. */
  isJoined(): boolean {
    return this.joined && this.playerId !== null;
  }

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (e) => {
        try {
          const msg: NetMsg = JSON.parse(e.data);
          this.handleMsg(msg);
        } catch (err) {
          // Swallowing silently turned any join-time build throw into an
          // undiagnosable stuck loading screen — always leave a trace.
          console.error('[Net] error handling server message:', err);
        }
      };
      this.ws.onclose = (e) => {
        this.connected = false;
        this.joined = false;
        this.playerId = null;
        this.shipId = null;
        this.matchId = null;
        this.pendingSnapshot = null;
        this.snapshotFlushQueued = false;
        this.onConnectionClosed?.();
        // Always print the close code: a bare "Disconnected" hides WHY (1002 =
        // the socket's byte stream was rejected as a protocol violation, 1006 =
        // the server vanished, 1000 = a clean goodbye) and turns a five-second
        // diagnosis into an afternoon of guessing.
        console.warn(`[Net] Disconnected (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`);
      };
    });
  }

  private handleMsg(msg: NetMsg) {
    switch (msg.type) {
      case 'welcome': {
        const p = msg.payload as WelcomePayload;
        this.clientId = p.clientId;
        this.onWelcome?.(p);
        break;
      }
      case 'join': {
        const p = msg.payload as { playerId: string; shipId: string; snapshot: GameState; matchId?: string };
        this.playerId = p.playerId;
        this.shipId = p.shipId;
        this.matchId = p.matchId ?? null;
        // Handshake complete — the match channel is open from here.
        this.joined = true;
        this.onJoin?.(p.playerId, p.shipId, p.snapshot);
        break;
      }
      case 'state_snapshot':
        this.queueSnapshot(msg.payload as GameState);
        break;
      case 'state_hot':
        this.queueHotSnapshot(msg.payload as HotSnapshotPayload);
        break;
      case 'player_downed': this.onPlayerDowned?.(msg.payload as Parameters<NonNullable<typeof this.onPlayerDowned>>[0]); break;
      case 'revive_complete': this.onReviveComplete?.(msg.payload as Parameters<NonNullable<typeof this.onReviveComplete>>[0]); break;
      case 'player_hit': this.onPlayerHit?.(msg.payload); break;
      case 'ship_hit': this.onShipHit?.(msg.payload); break;
      case 'ship_damage': this.onShipDamage?.(msg.payload); break;
      case 'ship_impact': this.onShipImpact?.(msg.payload); break;
      case 'kill_event': this.onKillEvent?.(msg.payload); break;
      case 'keg_exploded': this.onKegExploded?.(msg.payload); break;
      case 'chest_opened': this.onChestOpened?.(msg.payload); break;
      case 'barrel_opened': this.onBarrelOpened?.(msg.payload); break;
      case 'ship_upgraded': this.onShipUpgraded?.(msg.payload); break;
      case 'prop_removed': this.onPropRemoved?.(msg.payload); break;
      case 'treasure_sold': this.onTreasureSold?.(msg.payload); break;
      case 'armor_bought': this.onArmorBought?.(msg.payload); break;
      case 'ammo_refilled': this.onAmmoRefilled?.(msg.payload); break;
      case 'treasure_map': this.onTreasureMap?.(msg.payload); break;
      case 'trade_request': this.onTradeRequest?.(msg.payload); break;
      case 'trade_update': this.onTradeUpdate?.(msg.payload); break;
      case 'trade_result': this.onTradeResult?.(msg.payload); break;
      case 'game_over': this.onGameOver?.(msg.payload); break;
      case 'match_ended': this.onMatchEnded?.(msg.payload); break;
      case 'match_countdown': this.onMatchCountdown?.(msg.payload as Parameters<NonNullable<typeof this.onMatchCountdown>>[0]); break;
      case 'match_horn': this.onMatchHorn?.(msg.payload as Parameters<NonNullable<typeof this.onMatchHorn>>[0]); break;
      case 'crew_eliminated': this.onCrewEliminated?.(msg.payload as Parameters<NonNullable<typeof this.onCrewEliminated>>[0]); break;
      case 'player_spawned': this.onPlayerSpawned?.(msg.payload); break;
      case 'lobby_update': this.onLobbyUpdate?.(msg.payload as LobbyUpdatePayload); break;
      case 'lobby_left': this.clearMatchSession(); this.onLobbyLeft?.(); break;
      case 'lobby_error': this.onLobbyError?.((msg.payload as { reason?: string }).reason ?? 'Unknown error'); break;
      case 'queue_update': this.onQueueUpdate?.(msg.payload as QueueUpdatePayload); break;
      case 'match_start':
        // The NEXT match's join has not landed yet — shut the input channel
        // until it does, so the gap between match_start and join can't leak
        // inputs addressed to the match we just left.
        this.clearMatchSession();
        this.onMatchStart?.(msg.payload as MatchStartPayload);
        break;
      case 'stats_update': this.onStatsUpdate?.(msg.payload as PlayerStatsRecord); break;
    }
  }

  private queueSnapshot(snapshot: GameState) {
    this.pendingSnapshot = snapshot;
    if (this.snapshotFlushQueued) return;
    this.snapshotFlushQueued = true;
    requestAnimationFrame(() => {
      this.snapshotFlushQueued = false;
      const latest = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (latest) this.onSnapshot?.(latest);
    });
  }

  private pendingHot: HotSnapshotPayload | null = null;
  private hotFlushQueued = false;

  private queueHotSnapshot(hot: HotSnapshotPayload) {
    this.pendingHot = hot;
    if (this.hotFlushQueued) return;
    this.hotFlushQueued = true;
    requestAnimationFrame(() => {
      this.hotFlushQueued = false;
      const latest = this.pendingHot;
      this.pendingHot = null;
      if (latest) this.onHotSnapshot?.(latest);
    });
  }

  // ─── Game-scoped sends ───────────────────────────────────────
  // All of these address a player INSIDE a match, so they are gated on the join
  // handshake: before it lands there is no such player and the frame is noise.
  sendInput(input: PlayerInput) {
    if (!this.joined) return;
    this.send({ type: 'player_input', ts: Date.now(), payload: input });
  }
  sendTradeAction(action: TradeActionPayload) {
    if (!this.joined) return;
    this.send({ type: 'trade_action', ts: Date.now(), payload: action });
  }
  /** Ping is connection-scoped (the lobby answers it), so it needs no join. */
  sendPing() { this.send({ type: 'ping', ts: Date.now(), payload: { t: Date.now() } }); }
  /** Dev-only (honoured solo): ask the server to make bots ignore you + your ship. */
  sendDevBotPeace(enabled: boolean) {
    if (!this.joined) return;
    this.send({ type: 'dev_bot_peace', ts: Date.now(), payload: { enabled } });
  }

  // ─── Lobby-scoped sends ──────────────────────────────────────
  setName(name: string) { this.send({ type: 'set_name', ts: Date.now(), payload: { name } }); }
  createParty() { this.send({ type: 'create_party', ts: Date.now(), payload: {} }); }
  joinParty(code: string) { this.send({ type: 'join_party', ts: Date.now(), payload: { code } }); }
  leaveParty() { this.send({ type: 'leave_party', ts: Date.now(), payload: {} }); }
  updatePartySettings(settings: { botFill: number }) {
    this.send({ type: 'update_party_settings', ts: Date.now(), payload: settings });
  }
  startMatch() { this.send({ type: 'start_match', ts: Date.now(), payload: {} }); }
  queueJoin() { this.send({ type: 'queue_join', ts: Date.now(), payload: {} }); }
  queueLeave() { this.send({ type: 'queue_leave', ts: Date.now(), payload: {} }); }
  soloStart(botCount = 9) { this.send({ type: 'solo_start', ts: Date.now(), payload: { botCount } }); }
  // Leaving is decided HERE, not when the server's answer arrives: close the
  // match channel on the way out so the frames between the request and the
  // reply can't keep driving a player we have already walked away from.
  returnToMenu() {
    this.clearMatchSession();
    this.send({ type: 'return_to_menu', ts: Date.now(), payload: {} });
  }
  playAgain() {
    this.clearMatchSession();
    this.send({ type: 'play_again', ts: Date.now(), payload: {} });
  }

  /** Forget the current match: no match-scoped send may leave until the next join. */
  private clearMatchSession(): void {
    this.joined = false;
    this.playerId = null;
    this.shipId = null;
    this.matchId = null;
  }

  private send(msg: NetMsg): boolean {
    if (!this.isConnected()) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    if (!this.ws) return;
    this.connected = false;
    this.clearMatchSession();
    this.ws.close();
  }
}
