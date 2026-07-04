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
  public onKillEvent: ((payload: unknown) => void) | null = null;
  public onKegExploded: ((payload: unknown) => void) | null = null;
  public onChestOpened: ((payload: unknown) => void) | null = null;
  public onBarrelOpened: ((payload: unknown) => void) | null = null;
  public onShipUpgraded: ((payload: unknown) => void) | null = null;
  public onTreasureSold: ((payload: unknown) => void) | null = null;
  public onTreasureMap: ((payload: unknown) => void) | null = null;
  public onTradeRequest: ((payload: unknown) => void) | null = null;
  public onTradeUpdate: ((payload: unknown) => void) | null = null;
  public onTradeResult: ((payload: unknown) => void) | null = null;
  public onGameOver: ((payload: unknown) => void) | null = null;
  public onPlayerSpawned: ((payload: unknown) => void) | null = null;
  public onMatchEnded: ((payload: unknown) => void) | null = null;

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

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
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
        } catch {}
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.playerId = null;
        this.shipId = null;
        this.matchId = null;
        this.pendingSnapshot = null;
        this.snapshotFlushQueued = false;
        this.onConnectionClosed?.();
        console.warn('[Net] Disconnected');
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
      case 'kill_event': this.onKillEvent?.(msg.payload); break;
      case 'keg_exploded': this.onKegExploded?.(msg.payload); break;
      case 'chest_opened': this.onChestOpened?.(msg.payload); break;
      case 'barrel_opened': this.onBarrelOpened?.(msg.payload); break;
      case 'ship_upgraded': this.onShipUpgraded?.(msg.payload); break;
      case 'treasure_sold': this.onTreasureSold?.(msg.payload); break;
      case 'treasure_map': this.onTreasureMap?.(msg.payload); break;
      case 'trade_request': this.onTradeRequest?.(msg.payload); break;
      case 'trade_update': this.onTradeUpdate?.(msg.payload); break;
      case 'trade_result': this.onTradeResult?.(msg.payload); break;
      case 'game_over': this.onGameOver?.(msg.payload); break;
      case 'match_ended': this.onMatchEnded?.(msg.payload); break;
      case 'player_spawned': this.onPlayerSpawned?.(msg.payload); break;
      case 'lobby_update': this.onLobbyUpdate?.(msg.payload as LobbyUpdatePayload); break;
      case 'lobby_left': this.onLobbyLeft?.(); break;
      case 'lobby_error': this.onLobbyError?.((msg.payload as { reason?: string }).reason ?? 'Unknown error'); break;
      case 'queue_update': this.onQueueUpdate?.(msg.payload as QueueUpdatePayload); break;
      case 'match_start': this.onMatchStart?.(msg.payload as MatchStartPayload); break;
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
  sendInput(input: PlayerInput) { this.send({ type: 'player_input', ts: Date.now(), payload: input }); }
  sendTradeAction(action: TradeActionPayload) { this.send({ type: 'trade_action', ts: Date.now(), payload: action }); }
  sendPing() { this.send({ type: 'ping', ts: Date.now(), payload: { t: Date.now() } }); }

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
  returnToMenu() { this.send({ type: 'return_to_menu', ts: Date.now(), payload: {} }); }
  playAgain() { this.send({ type: 'play_again', ts: Date.now(), payload: {} }); }

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
    this.playerId = null;
    this.shipId = null;
    this.matchId = null;
    this.ws.close();
  }
}
