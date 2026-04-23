import type { NetMsg, PlayerInput, GameState, TradeActionPayload } from '../../shared/types/index.js';

export class NetworkClient {
  private ws!: WebSocket;
  private connected = false;
  public playerId: string | null = null;
  public shipId: string | null = null;

  public onSnapshot: ((state: GameState) => void) | null = null;
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
        console.warn('[Net] Disconnected');
      };
    });
  }

  private handleMsg(msg: NetMsg) {
    switch (msg.type) {
      case 'join': {
        const p = msg.payload as { playerId: string; shipId: string; snapshot: GameState };
        this.playerId = p.playerId;
        this.shipId   = p.shipId;
        this.onJoin?.(p.playerId, p.shipId, p.snapshot);
        break;
      }
      case 'state_snapshot':
        this.onSnapshot?.(msg.payload as GameState);
        break;
      case 'player_hit':
        this.onPlayerHit?.(msg.payload);
        break;
      case 'ship_hit':
        this.onShipHit?.(msg.payload);
        break;
      case 'kill_event':
        this.onKillEvent?.(msg.payload);
        break;
      case 'keg_exploded':
        this.onKegExploded?.(msg.payload);
        break;
      case 'chest_opened':
        this.onChestOpened?.(msg.payload);
        break;
      case 'barrel_opened':
        this.onBarrelOpened?.(msg.payload);
        break;
      case 'ship_upgraded':
        this.onShipUpgraded?.(msg.payload);
        break;
      case 'treasure_sold':
        this.onTreasureSold?.(msg.payload);
        break;
      case 'treasure_map':
        this.onTreasureMap?.(msg.payload);
        break;
      case 'trade_request':
        this.onTradeRequest?.(msg.payload);
        break;
      case 'trade_update':
        this.onTradeUpdate?.(msg.payload);
        break;
      case 'trade_result':
        this.onTradeResult?.(msg.payload);
        break;
      case 'game_over':
        this.onGameOver?.(msg.payload);
        break;
      case 'player_spawned':
        this.onPlayerSpawned?.(msg.payload);
        break;
    }
  }

  sendInput(input: PlayerInput) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'player_input', ts: Date.now(), payload: input }));
  }

  sendTradeAction(action: TradeActionPayload) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'trade_action', ts: Date.now(), payload: action }));
  }

  disconnect() {
    if (!this.ws) return;
    this.connected = false;
    this.playerId = null;
    this.shipId = null;
    this.ws.close();
  }

  isConnected() { return this.connected; }
}
