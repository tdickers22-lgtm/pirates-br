import type {
  HotSnapshotPayload,
  NetMsg, PlayerInput, GameState, TradeActionPayload,
  WelcomePayload, LobbyUpdatePayload, QueueUpdatePayload, MatchStartPayload,
  MatchDetachedPayload, PartyAvailablePayload,
  MatchCountdownPayload, MatchHornPayload, CrewEliminatedPayload, ShipSunkPayload,
  CarpenterPatchPayload,
  BountyRaisedPayload, CargoSpilledPayload, SpoilClaimedPayload, WreckEventPayload,
  PlayerStatsRecord, ResumeOkPayload, ResumeFailedPayload,
} from '../../shared/types/index.js';
import { PROTOCOL_VERSION } from '../../shared/types/index.js';
import { nextWaitMs, CONNECT_STEPS_MS, type ConnectProgress } from './connectPolicy.js';
import { VersionGate, type VersionPhase } from './versionGate.js';

interface EventTargetLike { addEventListener(type: string, fn: (e: { persisted?: boolean }) => void): void }
interface DocLike { visibilityState?: string; addEventListener(type: string, fn: () => void): void }

export class NetworkClient {
  private ws!: WebSocket;
  private connected = false;
  public clientId: string | null = null;

  // Game-scoped events
  public onSnapshot: ((state: GameState) => void) | null = null;
  public onHotSnapshot: ((hot: HotSnapshotPayload) => void) | null = null;
  /** Fired on EVERY hot as it lands, before coalescing — the interpolation
   *  history's feed. Must stay cheap: it runs in the socket message handler. */
  public onHotHistory: ((hot: HotSnapshotPayload) => void) | null = null;
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
  /** ECON-01 (w6.1): the Tallyman's answer to a [X] at his table — the sale, or
   *  the reason there was none. Both arrive on this one message (ok:boolean). */
  public onShopBought: ((payload: unknown) => void) | null = null;
  /** CAPTURE-01 (w6.1): a crewless hull changed hands at her own wheel. */
  public onShipCaptured: ((payload: unknown) => void) | null = null;
  public onAmmoRefilled: ((payload: unknown) => void) | null = null;
  /** The server heard your [X] and refused it — never leave a press unanswered. */
  public onInteractRefused: ((payload: unknown) => void) | null = null;
  public onTreasureMap: ((payload: unknown) => void) | null = null;
  public onTradeRequest: ((payload: unknown) => void) | null = null;
  public onTradeUpdate: ((payload: unknown) => void) | null = null;
  public onTradeResult: ((payload: unknown) => void) | null = null;
  public onGameOver: ((payload: unknown) => void) | null = null;
  public onPlayerSpawned: ((payload: unknown) => void) | null = null;
  public onMatchEnded: ((payload: unknown) => void) | null = null;
  /** Staged start: one per whole second while the sim is frozen in 'waiting'. */
  public onMatchCountdown: ((payload: MatchCountdownPayload) => void) | null = null;
  /** Staged start: the sim just went live. */
  public onMatchHorn: ((payload: MatchHornPayload) => void) | null = null;
  /** A HULL went under. Not an elimination: her crew are swimming out of her
   *  and still in the match. This is the moment the player must see (SHIP SUNK
   *  line, counter pulse, sting) — it was landed on the wire with no case here
   *  at all, so every founder was silent on screen (review-0 P1). */
  public onShipSunk: ((payload: ShipSunkPayload) => void) | null = null;
  /** A crew is OFF THE BOARD — CREWS AFLOAT just dropped. */
  public onCrewEliminated: ((payload: CrewEliminatedPayload) => void) | null = null;
  /** The carpenter spent a plank on a leak at anchor — own crew's feed line. */
  public onCarpenterPatch: ((payload: CarpenterPatchPayload) => void) | null = null;
  /** A crew crossed the gold-bounty line — hunt the treasure galleon. */
  public onBountyRaised: ((payload: BountyRaisedPayload) => void) | null = null;
  /** A foundering crew's cargo burst into the shallows — a dive site opened. */
  public onCargoSpilled: ((payload: CargoSpilledPayload) => void) | null = null;
  /** Someone swam into a piece of sunken cargo and banked it. */
  public onSpoilClaimed: ((payload: SpoilClaimedPayload) => void) | null = null;
  /** The Gilded Wreck rose at the announced ring centre, or the storm took her. */
  public onWreckEvent: ((payload: WreckEventPayload) => void) | null = null;

  // Lobby-scoped events
  public onWelcome: ((payload: WelcomePayload) => void) | null = null;
  public onLobbyUpdate: ((payload: LobbyUpdatePayload) => void) | null = null;
  public onLobbyLeft: (() => void) | null = null;
  public onLobbyError: ((reason: string) => void) | null = null;
  public onQueueUpdate: ((payload: QueueUpdatePayload) => void) | null = null;
  /** The match let go of you; `code` is the party you land back in (null: none left). */
  public onMatchDetached: ((payload: MatchDetachedPayload) => void) | null = null;
  /** A code refused with "at sea" is joinable again. */
  public onPartyAvailable: ((payload: PartyAvailablePayload) => void) | null = null;
  public onMatchStart: ((payload: MatchStartPayload) => void) | null = null;
  public onStatsUpdate: ((stats: PlayerStatsRecord) => void) | null = null;
  public onConnectionClosed: (() => void) | null = null;
  /** RECON-01 (netcode-31): the supervisor is between attempts. `attempt` is
   *  1-based, `nextInMs` is how long until it tries again — the HUD/menu chip
   *  says "Reconnecting… (3)" instead of the old dead Reload button. */
  public onReconnecting: ((attempt: number, nextInMs: number) => void) | null = null;
  /** The link came back AND the server still had our seat. */
  public onResumed: ((payload: ResumeOkPayload) => void) | null = null;
  /** The link came back but the seat is gone (grace expired, match reaped) or
   *  this bundle is too old to re-enter. The menu decides what to show. */
  public onResumeFailed: ((payload: ResumeFailedPayload) => void) | null = null;

  /**
   * RECON-01. The secret `welcome` hands out, replayed as `resume` after a blip
   * to take the same seat back. Kept in sessionStorage as well as in memory so a
   * RELOAD (the only recovery this client used to offer) can also resume rather
   * than start a fresh match — same tab, same session, and it dies with the tab.
   */
  public sessionToken: string | null = null;
  private static readonly TOKEN_KEY = 'piratesBR.sessionToken';
  /** The url the supervisor reconnects to, and whether it should. */
  private url: string | null = null;
  private wantConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectStartedAt = 0;
  /**
   * BACKOFF, 0.5 → 8 s, with 20% jitter, for at most CONNECT_BUDGET_MS (connectPolicy.ts).
   * The budget is the server's grace (RECONNECT_GRACE_MS, 60 s) — past it the
   * seat is gone and retrying only holds a loading screen open on a lie.
   * Jitter matters for the case this exists for: a server restart drops every
   * client in the same millisecond, and un-jittered backoff would bring all of
   * them back in the same millisecond too, onto a process that is still booting.
   */
  /** Close codes that mean "the link failed", not "you were let go". 1000 is a
   *  clean goodbye (match reaped, we called disconnect) and 1008 is a policy
   *  kick — reconnecting into either is how a client ends up in a hot loop. */
  private static readonly RESUMABLE_CLOSE_CODES = new Set([1001, 1006, 1011, 1012, 1013]);

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

  /**
   * App-level heartbeat. The server drops a socket that has gone silent past its
   * budget, and a client is legitimately silent for long stretches: the whole
   * menu, the party panel, the matchmaking queue and the pre-horn countdown all
   * put nothing on the wire (only a live match streams player_input). The
   * browser's automatic pong answers the server's ws ping, but only while the
   * page is actually pumping its socket — so this timer is the belt to that
   * brace, and it is the thing that keeps a menu-idling player connected.
   *
   * It also measures round-trip latency: the server echoes the ping payload
   * back as `pong`, which is where `latencyMs` comes from.
   *
   * THIS TIMER IS THE FALLBACK PATH ONLY. When the socket lives in the worker
   * (see socket.worker.ts) the worker owns the beat, because a main thread pinned
   * by a world build cannot fire a timer OR drain the socket — and a socket the
   * renderer stops draining stops answering the server's ws ping too. This timer
   * runs only when the worker could not be created at all.
   */
  private static readonly HEARTBEAT_INTERVAL_MS = 3_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingSentAt = 0;
  private latencyMs: number | null = null;

  /**
   * The socket, off the main thread. Null only if Worker construction failed, in
   * which case everything below falls back to a main-thread `this.ws` that
   * behaves exactly as it did before the worker existed.
   */
  private worker: Worker | null = null;
  /** Open/closed as reported by whichever transport is in play. */
  private transportOpen = false;

  isConnected(): boolean {
    return this.connected && this.transportOpen;
  }

  /** True once the join handshake for the current match has completed. */
  isJoined(): boolean {
    return this.joined;
  }

  /**
   * RECON-01 (netcode-31) + b1.1e (correctness-04): connect is a SUPERVISOR,
   * and there is exactly ONE of it at a time.
   *
   * The first connect retries on the connectPolicy schedule for the server's
   * 60 s seat budget, reporting `onConnectProgress`, and rejects once when the
   * budget is spent (the loading screen then offers Retry -> `retryNow()`).
   * While that loop owns the retries, a transport's own 'closed' never starts a
   * second timer (the old race: two supervisors, the second tore the first
   * down and connect() never settled). A fresh page never sends `resume`: only a
   * token handed out on THIS page is replayed after a drop.
   */
  async connect(url: string): Promise<void> {
    this.url = url;
    this.wantConnected = true;
    this.installLifecycle();
    if (this.transportOpen) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.supervising = true;
    this.reconnectStartedAt = Date.now();
    let attempt = 0;
    try {
      for (;;) {
        try {
          await this.openTransport(url);
          this.reconnectAttempt = 0;
          return;
        } catch (err) {
          this.teardownTransport();
          attempt += 1;
          const wait = nextWaitMs(attempt, Date.now() - this.reconnectStartedAt);
          if (!this.wantConnected || wait === null) throw err;
          this.reportProgress(this.isOffline() ? 'offline' : 'retrying', attempt, wait);
          await this.sleepOrKick(wait);
          if (!this.wantConnected) throw err;
        }
      }
    } finally {
      this.supervising = false;
      this.kick = null;
    }
  }

  /** The Retry button: a fresh 60 s budget. */
  retryNow(): Promise<void> {
    if (!this.url) return Promise.reject(new Error('never connected'));
    return this.connect(this.url);
  }

  /** Progress for the loading screen (first connect) — see connectPolicy.connectCopy. */
  public onConnectProgress: ((p: ConnectProgress) => void) | null = null;
  private reportProgress(phase: ConnectProgress['phase'], attempt: number, nextInMs: number): void {
    try { this.onConnectProgress?.({ phase, attempt, nextInMs }); } catch (err) { console.error('[Net] connect progress handler threw:', err); }
  }

  /** 0.5/1/2/4/8 s, then 8 s forever, ±20% jitter (connectPolicy). */
  static backoffMs(attempt: number): number {
    return nextWaitMs(attempt, 0, Math.random, Number.POSITIVE_INFINITY) ?? CONNECT_STEPS_MS[CONNECT_STEPS_MS.length - 1];
  }

  private supervising = false;
  private kick: (() => void) | null = null;
  private sleepOrKick(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.kick = null; resolve(); }, ms);
      this.kick = () => { clearTimeout(t); this.kick = null; resolve(); };
    });
  }

  private isOffline(): boolean {
    try { return globalThis.navigator?.onLine === false || this.offline; } catch { return this.offline; }
  }

  // ── Page lifecycle (vm:online:2, vm:correctness:1, vm:crossdevice:4) ────────
  // iOS/Android freeze a backgrounded page and drop its socket, often without a
  // close event reaching us; a wifi -> 4G handover does the same. Inside the
  // server's 60 s seat grace the client must come back on its own.
  private lifecycleInstalled = false;
  private offline = false;
  private hiddenAt = 0;
  private lastInboundAt = 0;
  private foregroundCheck: ReturnType<typeof setTimeout> | null = null;
  /** Hidden longer than this -> verify the socket is really alive on return. */
  private static readonly BACKGROUND_SUSPECT_MS = 5_000;
  /** Pong cadence is 3 s; nothing inbound for this long after returning = dead. */
  private static readonly FOREGROUND_PROBE_MS = 4_000;

  installLifecycle(win: EventTargetLike | null = (globalThis as unknown as { addEventListener?: unknown }).addEventListener ? globalThis as unknown as EventTargetLike : null,
    doc: DocLike | null = (globalThis as unknown as { document?: DocLike }).document ?? null): void {
    if (this.lifecycleInstalled || !win) return;
    this.lifecycleInstalled = true;
    win.addEventListener('offline', () => {
      this.offline = true;
      if (!this.transportOpen && this.wantConnected) this.reportProgress('offline', this.reconnectAttempt, 0);
    });
    win.addEventListener('online', () => { this.offline = false; this.retrySoon(); });
    win.addEventListener('pagehide', () => { this.hiddenAt ||= Date.now(); });
    win.addEventListener('pageshow', (e: { persisted?: boolean }) => { if (e?.persisted) this.onForeground(); });
    doc?.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') { this.hiddenAt ||= Date.now(); return; }
      this.onForeground();
    });
  }

  private onForeground(): void {
    const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (!this.wantConnected) return;
    if (!this.transportOpen) { this.retrySoon(); return; }
    if (hiddenFor < NetworkClient.BACKGROUND_SUSPECT_MS) return;
    // The socket SAYS it is open. Prove it: the worker's 3 s ping draws a pong.
    const since = Date.now();
    if (this.foregroundCheck) clearTimeout(this.foregroundCheck);
    this.foregroundCheck = setTimeout(() => {
      this.foregroundCheck = null;
      if (!this.transportOpen || this.lastInboundAt >= since) return;
      console.warn(`[Net] no traffic ${NetworkClient.FOREGROUND_PROBE_MS} ms after ${Math.round(hiddenFor / 1000)} s in the background; reconnecting`);
      this.teardownTransport();
      this.noteClosed(1006, 'stale after background');
    }, NetworkClient.FOREGROUND_PROBE_MS);
  }

  /** Something says the network is back: skip the rest of the backoff wait. */
  private retrySoon(): void {
    if (!this.wantConnected || this.transportOpen) return;
    if (this.kick) { this.kick(); return; }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.runReconnectAttempt();
    }
  }

  private openTransport(url: string): Promise<void> {
    this.teardownTransport();
    const worker = this.spawnWorker();
    return worker ? this.connectViaWorker(worker, url) : this.connectDirect(url);
  }

  /** Settles the in-flight attempt's promise when its transport is torn down. */
  private abandonAttempt: ((err: Error) => void) | null = null;

  /** Drop whatever transport is in play without telling the supervisor to stop. */
  private teardownTransport(): void {
    this.stopHeartbeat();
    const abandon = this.abandonAttempt;
    this.abandonAttempt = null;
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.postMessage({ k: 'close' }); } catch {}
      try { worker.terminate(); } catch {}
    } else if (this.ws) {
      try {
        this.ws.onopen = null; this.ws.onclose = null; this.ws.onerror = null; this.ws.onmessage = null;
        this.ws.close();
      } catch {}
    }
    this.connected = false;
    this.transportOpen = false;
    // A superseded attempt must settle, never hang (correctness-04).
    abandon?.(new Error('transport superseded'));
  }

  /**
   * The link dropped on its own. If the server may still be holding our seat,
   * re-open and present the token; the server answers resume_ok (and a `join`
   * carrying the world, which re-anchors the scene through the one path that is
   * already proven) or resume_failed.
   */
  private scheduleReconnect(code: number): void {
    if (!this.wantConnected || !this.url) return;
    // connect() owns the retries until its first open: no second supervisor.
    if (this.supervising) return;
    if (!NetworkClient.RESUMABLE_CLOSE_CODES.has(code)) { this.wantConnected = false; return; }
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt === 0) {
      this.reconnectStartedAt = Date.now();
      // The token THIS page was handed; never one from sessionStorage.
      this.resumeToken = this.sessionToken;
    }
    this.reconnectAttempt += 1;
    const wait = nextWaitMs(this.reconnectAttempt, Date.now() - this.reconnectStartedAt);
    if (wait === null) {
      this.wantConnected = false;
      this.resumeToken = null;
      this.onResumeFailed?.({ reason: 'expired' });
      return;
    }
    this.onReconnecting?.(this.reconnectAttempt, wait);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.runReconnectAttempt();
    }, wait);
  }

  private resumeToken: string | null = null;
  private runReconnectAttempt(): void {
    if (!this.wantConnected || !this.url || this.supervising) return;
    this.openTransport(this.url).then(() => {
      this.reconnectAttempt = 0;
      const token = this.resumeToken;
      this.resumeToken = null;
      if (!token) return;
      this.send({ type: 'resume', ts: Date.now(), payload: { token, protocolVersion: PROTOCOL_VERSION } });
    }).catch(() => {
      this.teardownTransport();
      this.scheduleReconnect(1006);
    });
  }

  /** The token a previous load of this tab stored. Only an explicit caller may
   *  use it (a deliberate "reload to rejoin"); the supervisor never does. */
  storedSessionToken(): string | null {
    try { return globalThis.sessionStorage?.getItem(NetworkClient.TOKEN_KEY) ?? null; } catch { return null; }
  }

  // ── Version gate (online-05) ────────────────────────────────────────────────
  private versionGate: VersionGate = new VersionGate();
  private phaseProvider: () => VersionPhase = () => (this.joined ? 'in_match' : 'menu');
  setVersionGate(gate: VersionGate | null, phase?: () => VersionPhase): void {
    if (gate) this.versionGate = gate;
    if (phase) this.phaseProvider = phase;
  }

  /** Build the socket worker, or null on any environment that refuses one. */
  private spawnWorker(): Worker | null {
    try {
      return new Worker(new URL('./socket.worker.ts', import.meta.url), {
        type: 'module',
        name: 'pirates-socket',
      });
    } catch (err) {
      // Not fatal — the direct path below is the pre-worker behaviour, which
      // works fine for anyone whose main thread never stalls past the budget.
      console.warn('[Net] socket worker unavailable, using main-thread socket:', err);
      return null;
    }
  }

  private connectViaWorker(worker: Worker, url: string): Promise<void> {
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      this.abandonAttempt = (err) => { if (!settled) { settled = true; reject(err); } };
      worker.onmessage = (e: MessageEvent<
        | { k: 'open' }
        | { k: 'msg'; data: string; n: number; receivedAt: number }
        | { k: 'closed'; code: number; reason: string }
        | { k: 'failed' }
      >) => {
        const m = e.data;
        switch (m.k) {
          case 'open':
            this.connected = true;
            this.transportOpen = true;
            this.lastInboundAt = Date.now();
            // No startHeartbeat() here: the worker is already beating, and a
            // second beat from a thread that can stall is worse than none.
            if (!settled) { settled = true; this.abandonAttempt = null; resolve(); }
            break;
          case 'msg':
            // ACK FIRST, unconditionally. This is the worker's only signal that
            // we are keeping up; skipping it on a throwing frame would wedge its
            // coalescing slots shut for the rest of the session.
            worker.postMessage({ k: 'ack', n: m.n });
            this.ingest(m.data, m.receivedAt);
            break;
          case 'closed':
            // An attempt that never opened is the supervisor's business, not a
            // disconnect: no "Disconnected" UI, no second retry timer.
            if (!settled) { settled = true; this.abandonAttempt = null; reject(new Error(`socket closed (${m.code})`)); break; }
            this.noteClosed(m.code, m.reason);
            break;
          case 'failed':
            this.transportOpen = false;
            if (!settled) { settled = true; this.abandonAttempt = null; reject(new Error('socket failed to open')); }
            break;
        }
      };
      worker.onerror = (err) => {
        console.error('[Net] socket worker error:', err.message);
        if (!settled) { settled = true; this.abandonAttempt = null; reject(new Error(err.message || 'socket worker error')); }
      };
      worker.postMessage({ k: 'open', url });
    });
  }

  /** Pre-worker path, kept byte-for-byte in behaviour for environments without workers. */
  private connectDirect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.abandonAttempt = (err) => { if (!settled) { settled = true; reject(err); } };
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        this.transportOpen = true;
        this.lastInboundAt = Date.now();
        this.startHeartbeat();
        if (!settled) { settled = true; this.abandonAttempt = null; resolve(); }
      };
      this.ws.onerror = (e) => { if (!settled) { settled = true; this.abandonAttempt = null; reject(e); } };
      this.ws.onmessage = (e) => this.ingest(e.data as string, Date.now());
      this.ws.onclose = (e) => {
        if (!settled) { settled = true; this.abandonAttempt = null; reject(new Error(`socket closed (${e.code})`)); return; }
        this.noteClosed(e.code, e.reason);
      };
    });
  }

  /** Parse + route one server frame. Identical for both transports. */
  private ingest(raw: string, receivedAt = Date.now()): void {
    this.lastInboundAt = Date.now();
    try {
      const msg: NetMsg = JSON.parse(raw);
      this.handleMsg(msg, receivedAt);
    } catch (err) {
      // Swallowing silently turned any join-time build throw into an
      // undiagnosable stuck loading screen — always leave a trace.
      console.error('[Net] error handling server message:', err);
    }
  }

  private noteClosed(code: number, reason: string): void {
    this.connected = false;
    this.transportOpen = false;
    this.joined = false;
    this.stopHeartbeat();
    this.latencyMs = null;
    this.serverClock = null;
    this.pendingSnapshot = null;
    this.snapshotFlushQueued = false;
    this.onConnectionClosed?.();
    this.scheduleReconnect(code);
    // Always print the close code: a bare "Disconnected" hides WHY (1002 =
    // the socket's byte stream was rejected as a protocol violation, 1006 =
    // the server vanished, 1000 = a clean goodbye) and turns a five-second
    // diagnosis into an afternoon of guessing.
    console.warn(`[Net] Disconnected (code ${code}${reason ? `: ${reason}` : ''})`);
  }

  /**
   * PER-EVENT GUARD (liveplay-05). Each server message's bookkeeping above (clock
   * pairing, snapshot queueing, session state) runs outside this; only the game's
   * callback runs inside it, so a cosmetic throw in a handler (it was a NaN
   * reaching an AudioParam) can no longer unwind the dispatcher. The log line keeps
   * the census prefix so the 5-minute bot-match gate still counts every one.
   */
  handlerFaults = 0;
  private emit(type: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.handlerFaults += 1;
      console.error(`[Net] error handling server message '${type}':`, err);
    }
  }

  private handleMsg(msg: NetMsg, receivedAt: number) {
    switch (msg.type) {
      case 'welcome': {
        const p = msg.payload as WelcomePayload;
        this.clientId = p.clientId;
        this.sessionToken = p.sessionToken ?? null;
        if (this.sessionToken) {
          try { globalThis.sessionStorage?.setItem(NetworkClient.TOKEN_KEY, this.sessionToken); } catch {}
        }
        this.emit(msg.type, () => this.onWelcome?.(p));
        // online-05: a server on another build reloads this tab (menu: now; in a
        // match: when it is over). No-op while either side reports no build id.
        this.emit('version_gate', () => { this.versionGate.onWelcome(p.buildId, this.phaseProvider()); });
        break;
      }
      case 'resume_ok': {
        const p = msg.payload as ResumeOkPayload;
        this.clientId = p.clientId;
        // The `join` that follows re-opens the match channel; until it lands,
        // nothing match-scoped may leave (same rule as a fresh join).
        this.joined = false;
        this.emit(msg.type, () => this.onResumed?.(p));
        break;
      }
      case 'resume_failed': {
        this.wantConnected = false;
        this.emit(msg.type, () => this.onResumeFailed?.(msg.payload as ResumeFailedPayload));
        break;
      }
      case 'join': {
        const p = msg.payload as { playerId: string; shipId: string; snapshot: GameState };
        // Handshake complete — the match channel is open from here.
        this.joined = true;
        this.emit(msg.type, () => this.onJoin?.(p.playerId, p.shipId, p.snapshot));
        break;
      }
      case 'state_snapshot': {
        const p = msg.payload as GameState;
        this.noteServerClock(p.serverTime, receivedAt);
        this.queueSnapshot(p);
        break;
      }
      case 'state_hot': {
        const p = msg.payload as HotSnapshotPayload;
        this.noteServerClock(p.serverTime, receivedAt);
        // EVERY hot reaches the interpolation history, not just the one per rAF
        // that survives the coalescing below. `queueHotSnapshot` keeps only the
        // newest payload until the next frame, which is right for APPLYING one
        // (merging into state and rebuilding the indexes is real work, and four
        // superseded merges are four wasted ones) and wrong for RECORDING one:
        // on the machine this game is for, a frame is 180ms, so four of every
        // five samples were being thrown away and the buffer measured the
        // client's frame rate as the server's snapshot rate — a 178ms interval
        // against a real 32ms, which inflated the render delay six-fold.
        // Recording a sample is six float writes into a ring; it can afford to
        // happen on arrival.
        this.emit(msg.type, () => this.onHotHistory?.(p));
        this.queueHotSnapshot(p);
        break;
      }
      case 'player_downed': this.emit('player_downed', () => this.onPlayerDowned?.(msg.payload as Parameters<NonNullable<typeof this.onPlayerDowned>>[0])); break;
      case 'revive_complete': this.emit('revive_complete', () => this.onReviveComplete?.(msg.payload as Parameters<NonNullable<typeof this.onReviveComplete>>[0])); break;
      case 'player_hit': this.emit('player_hit', () => this.onPlayerHit?.(msg.payload)); break;
      case 'ship_hit': this.emit('ship_hit', () => this.onShipHit?.(msg.payload)); break;
      case 'ship_damage': this.emit('ship_damage', () => this.onShipDamage?.(msg.payload)); break;
      case 'ship_impact': this.emit('ship_impact', () => this.onShipImpact?.(msg.payload)); break;
      case 'kill_event': this.emit('kill_event', () => this.onKillEvent?.(msg.payload)); break;
      case 'keg_exploded': this.emit('keg_exploded', () => this.onKegExploded?.(msg.payload)); break;
      case 'chest_opened': this.emit('chest_opened', () => this.onChestOpened?.(msg.payload)); break;
      case 'barrel_opened': this.emit('barrel_opened', () => this.onBarrelOpened?.(msg.payload)); break;
      case 'ship_upgraded': this.emit('ship_upgraded', () => this.onShipUpgraded?.(msg.payload)); break;
      case 'prop_removed': this.emit('prop_removed', () => this.onPropRemoved?.(msg.payload)); break;
      case 'treasure_sold': this.emit('treasure_sold', () => this.onTreasureSold?.(msg.payload)); break;
      case 'armor_bought': this.emit('armor_bought', () => this.onArmorBought?.(msg.payload)); break;
      case 'shop_bought': this.emit('shop_bought', () => this.onShopBought?.(msg.payload)); break;
      case 'ship_captured': this.emit('ship_captured', () => this.onShipCaptured?.(msg.payload)); break;
      case 'ammo_refilled': this.emit('ammo_refilled', () => this.onAmmoRefilled?.(msg.payload)); break;
      case 'interact_refused': this.emit('interact_refused', () => this.onInteractRefused?.(msg.payload)); break;
      case 'treasure_map': this.emit('treasure_map', () => this.onTreasureMap?.(msg.payload)); break;
      case 'trade_request': this.emit('trade_request', () => this.onTradeRequest?.(msg.payload)); break;
      case 'trade_update': this.emit('trade_update', () => this.onTradeUpdate?.(msg.payload)); break;
      case 'trade_result': this.emit('trade_result', () => this.onTradeResult?.(msg.payload)); break;
      case 'game_over': this.emit('game_over', () => this.onGameOver?.(msg.payload)); break;
      case 'match_ended': this.emit('match_ended', () => this.onMatchEnded?.(msg.payload)); break;
      case 'match_countdown': this.emit('match_countdown', () => this.onMatchCountdown?.(msg.payload as Parameters<NonNullable<typeof this.onMatchCountdown>>[0])); break;
      case 'match_horn': this.emit('match_horn', () => this.onMatchHorn?.(msg.payload as Parameters<NonNullable<typeof this.onMatchHorn>>[0])); break;
      case 'ship_sunk': this.emit('ship_sunk', () => this.onShipSunk?.(msg.payload as Parameters<NonNullable<typeof this.onShipSunk>>[0])); break;
      case 'crew_eliminated': this.emit('crew_eliminated', () => this.onCrewEliminated?.(msg.payload as Parameters<NonNullable<typeof this.onCrewEliminated>>[0])); break;
      case 'carpenter_patch': this.emit('carpenter_patch', () => this.onCarpenterPatch?.(msg.payload as Parameters<NonNullable<typeof this.onCarpenterPatch>>[0])); break;
      case 'bounty_raised': this.emit('bounty_raised', () => this.onBountyRaised?.(msg.payload as Parameters<NonNullable<typeof this.onBountyRaised>>[0])); break;
      case 'cargo_spilled': this.emit('cargo_spilled', () => this.onCargoSpilled?.(msg.payload as Parameters<NonNullable<typeof this.onCargoSpilled>>[0])); break;
      case 'spoil_claimed': this.emit('spoil_claimed', () => this.onSpoilClaimed?.(msg.payload as Parameters<NonNullable<typeof this.onSpoilClaimed>>[0])); break;
      case 'wreck_event': this.emit('wreck_event', () => this.onWreckEvent?.(msg.payload as Parameters<NonNullable<typeof this.onWreckEvent>>[0])); break;
      case 'player_spawned': this.emit('player_spawned', () => this.onPlayerSpawned?.(msg.payload)); break;
      case 'lobby_update': this.emit('lobby_update', () => this.onLobbyUpdate?.(msg.payload as LobbyUpdatePayload)); break;
      case 'lobby_left': this.clearMatchSession(); this.emit(msg.type, () => this.onLobbyLeft?.()); break;
      case 'lobby_error': this.emit('lobby_error', () => this.onLobbyError?.((msg.payload as { reason?: string }).reason ?? 'Unknown error')); break;
      case 'queue_update': this.emit('queue_update', () => this.onQueueUpdate?.(msg.payload as QueueUpdatePayload)); break;
      // The match is over for us either way: shut the input channel like
      // lobby_left does, so nothing addressed to the old match leaks out.
      case 'match_detached': this.clearMatchSession(); this.emit(msg.type, () => this.onMatchDetached?.(msg.payload as MatchDetachedPayload)); break;
      case 'party_available': this.emit('party_available', () => this.onPartyAvailable?.(msg.payload as PartyAvailablePayload)); break;
      case 'match_start':
        // The NEXT match's join has not landed yet — shut the input channel
        // until it does, so the gap between match_start and join can't leak
        // inputs addressed to the match we just left.
        this.clearMatchSession();
        this.emit(msg.type, () => this.onMatchStart?.(msg.payload as MatchStartPayload));
        break;
      case 'stats_update': this.emit('stats_update', () => this.onStatsUpdate?.(msg.payload as PlayerStatsRecord)); break;
      case 'pong': this.notePong(msg.payload); break;
    }
  }

  /**
   * THE SIM CLOCK, PAIRED WITH OURS AT THE MOMENT IT CAME OFF THE SOCKET.
   *
   * The overload detector's whole question is whether the server's sim time
   * advances as fast as the wall clock. Answering it needs the two clocks read
   * at the SAME instant, and the only place that is true is here, in the message
   * handler, before the snapshot goes into the rAF coalescing slot.
   *
   * Taking the pair later — when the snapshot is applied, or when the HUD next
   * gets a turn — quantises the local half by the frame length and the server
   * half not at all, and the difference between the two is charged to the
   * server. Measured: on a client held at 1.8s a frame, that error raised
   * "SERVER OVERLOADED — sim 1s behind" against a server that had not missed a
   * tick, in two runs out of five. The accusation was manufactured entirely by
   * the client's own frame length, and it is pointed at somebody else's machine.
   */
  private serverClock: { server: number; at: number } | null = null;

  /** The newest (sim time, local time) pair, or null before the first snapshot. */
  getServerClock(): { server: number; at: number } | null {
    return this.serverClock;
  }

  private noteServerClock(serverTime: unknown, receivedAt: number): void {
    if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
    if (!Number.isFinite(receivedAt)) return;
    // Monotonic: the wire is unordered enough that an older snapshot can land
    // after a newer one, and a pair that walks the sim clock BACKWARDS reads as
    // dilation that never happened.
    if (this.serverClock && serverTime <= this.serverClock.server) return;
    this.serverClock = { server: serverTime, at: receivedAt };
  }

  // ─── Heartbeat ───────────────────────────────────────────────
  /** Round-trip time of the last answered heartbeat, or null before the first. */
  getLatencyMs(): number | null {
    return this.latencyMs;
  }

  /** One heartbeat beat: keeps the server's liveness sweep happy and times the RTT. */
  sendPing(): void {
    const sentAt = Date.now();
    if (this.send({ type: 'ping', ts: sentAt, payload: { t: sentAt } })) {
      this.lastPingSentAt = sentAt;
    }
  }

  private notePong(payload: unknown): void {
    // The server echoes our payload, so the send time rides along and a pong
    // that overtakes a later ping still measures its OWN round trip.
    const echoed = (payload as { t?: unknown } | null)?.t;
    const sentAt = typeof echoed === 'number' && Number.isFinite(echoed) ? echoed : this.lastPingSentAt;
    if (!sentAt) return;
    const rtt = Date.now() - sentAt;
    // A clock that jumped mid-flight would otherwise post an absurd latency.
    if (rtt >= 0 && rtt < 60_000) this.latencyMs = rtt;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Beat once immediately: a client that opens the socket and then sits on the
    // name field should be counted as alive from the first second, not the third.
    this.sendPing();
    // globalThis, not window: the RECON-01 gate drives this client from node
    // (scripts/test-net-resilience.mjs), and `window` there is a ReferenceError
    // that killed the socket the moment it opened.
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) {
        this.stopHeartbeat();
        return;
      }
      this.sendPing();
    }, NetworkClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
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
  /** ECON-01 SEND HALF. The server has routed, validated and answered
   *  'shop_buy' since w6.1, but w6.1 deferred the panel, so nothing in the
   *  client ever sent one and the whole gold sink was unreachable. Answered on
   *  'shop_bought' (ok or a refusal reason) — see Game.onShopBought. */
  sendShopBuy(line: string) {
    if (!this.joined) return;
    this.send({ type: 'shop_buy', ts: Date.now(), payload: { line } });
  }
  sendTradeAction(action: TradeActionPayload) {
    if (!this.joined) return;
    this.send({ type: 'trade_action', ts: Date.now(), payload: action });
  }
  /** Dev-only (honoured solo): ask the server to make bots ignore you + your ship. */
  sendDevBotPeace(enabled: boolean) {
    if (!this.joined) return;
    this.send({ type: 'dev_bot_peace', ts: Date.now(), payload: { enabled } });
  }

  /** Dev-only (server honours it solo): set banked gold, to drive the hold-cargo
   *  loop — crates in the hold, ballast, the bounty, the spill on founder. */
  sendDevGrantGold(gold: number) {
    if (!this.joined) return;
    this.send({ type: 'dev_grant_gold', ts: Date.now(), payload: { gold } });
  }

  // ─── Lobby-scoped sends ──────────────────────────────────────
  setName(name: string) { this.send({ type: 'set_name', ts: Date.now(), payload: { name } }); }
  createParty() { this.send({ type: 'create_party', ts: Date.now(), payload: {} }); }
  joinParty(code: string) { this.send({ type: 'join_party', ts: Date.now(), payload: { code } }); }
  leaveParty() { this.send({ type: 'leave_party', ts: Date.now(), payload: {} }); }
  updatePartySettings(settings: { botFill?: number; mode?: string }) {
    this.send({ type: 'update_party_settings', ts: Date.now(), payload: settings });
  }
  // PARTY-01 (netcode-14/15): the server has accepted these three since lane
  // 2.3 and no client ever sent one, so the ready tick, the kick and the crown
  // were server-only vocabulary. A roster row is a control now.
  partyReady(ready: boolean) { this.send({ type: 'party_ready', ts: Date.now(), payload: { ready } }); }
  partyKick(clientId: string) { this.send({ type: 'party_kick', ts: Date.now(), payload: { clientId } }); }
  partyTransferHost(clientId: string) {
    this.send({ type: 'party_transfer_host', ts: Date.now(), payload: { clientId } });
  }
  startMatch() { this.send({ type: 'start_match', ts: Date.now(), payload: {} }); }
  /** The mode picker travels with the request: a lone pirate queueing for Duos
   *  must not be dispatched into Solo's twelve-hull fleet (MODE-01). */
  queueJoin(mode?: string) { this.send({ type: 'queue_join', ts: Date.now(), payload: mode ? { mode } : {} }); }
  queueLeave() { this.send({ type: 'queue_leave', ts: Date.now(), payload: {} }); }
  soloStart(botCount = 9) { this.send({ type: 'solo_start', ts: Date.now(), payload: { botCount } }); }
  // Leaving is decided HERE, not when the server's answer arrives: close the
  // match channel on the way out so the frames between the request and the
  // reply can't keep driving a player we have already walked away from.
  returnToMenu() {
    this.clearMatchSession();
    this.send({ type: 'return_to_menu', ts: Date.now(), payload: {} });
    // A reload owed since a mid-match welcome from a newer server: after the
    // goodbye above has left (the worker posts it at once), not before.
    setTimeout(() => this.emit('version_gate', () => { this.versionGate.onMenu(); }), 150);
  }
  playAgain() {
    this.clearMatchSession();
    this.send({ type: 'play_again', ts: Date.now(), payload: {} });
  }

  /** Forget the current match: no match-scoped send may leave until the next join. */
  private clearMatchSession(): void {
    this.joined = false;
  }

  private send(msg: NetMsg): boolean {
    if (!this.isConnected()) return false;
    try {
      const data = JSON.stringify(msg);
      if (this.worker) this.worker.postMessage({ k: 'send', data });
      else this.ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    // A deliberate goodbye: the supervisor must not fight it.
    this.wantConnected = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.foregroundCheck) { clearTimeout(this.foregroundCheck); this.foregroundCheck = null; }
    this.resumeToken = null;
    this.kick?.();
    const abandon = this.abandonAttempt;
    this.abandonAttempt = null;
    abandon?.(new Error('disconnected'));
    // Stop the timer even if there is no socket to close — connect() can reject
    // before ever assigning one, and a stray interval would outlive the client.
    this.stopHeartbeat();
    this.connected = false;
    this.transportOpen = false;
    this.clearMatchSession();
    if (this.worker) {
      // Ask for a clean close, THEN terminate: a bare terminate() drops the
      // socket without a close frame and the server has to wait out the silence
      // budget before it notices the player left.
      try { this.worker.postMessage({ k: 'close' }); } catch {}
      const worker = this.worker;
      this.worker = null;
      setTimeout(() => worker.terminate(), 250);
      return;
    }
    if (!this.ws) return;
    this.ws.close();
  }
}
