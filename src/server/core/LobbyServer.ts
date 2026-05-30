import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import type {
  NetMsg, LobbyUpdatePayload, LobbyMember, QueueUpdatePayload,
  WelcomePayload, MatchStartPayload, PlayerStatsRecord,
} from '../../shared/types/index.js';
import { Match, type MatchEndResult } from './Match.js';
import { StatsStore, defaultStatsPath } from './StatsStore.js';

// ── Tunables ──────────────────────────────────────────────────
const PARTY_CAPACITY = 16;
const MATCH_TOTAL_SHIPS = 10;
const PARTY_DEFAULT_BOTS = MATCH_TOTAL_SHIPS - 1;
const PARTY_MAX_BOTS = MATCH_TOTAL_SHIPS - 1;
const QUEUE_TARGET = MATCH_TOTAL_SHIPS;
const QUEUE_MIN_HUMANS_FAST = 2;
const QUEUE_MIN_HUMANS_FALLBACK = 1;
const QUEUE_TIMER_SECONDS = 15;
const QUEUE_MATCH_BOTS_FILL_TO = MATCH_TOTAL_SHIPS; // total ships per match (humans + bots)
const MATCH_GC_AFTER_END_MS = 60_000;
const ENDED_MATCH_DETACH_MS = 25_000; // auto-return-to-menu after this if client doesn't act

const PROJECT_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));
const CLIENT_DIST_ROOT = join(PROJECT_ROOT, 'dist/client');
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

type ClientState = 'menu' | 'party' | 'queue' | 'in_match' | 'match_ended';

interface ClientSession {
  id: string;
  ws: WebSocket;
  name: string;
  state: ClientState;
  partyCode?: string;
  matchId?: string;
  /** playerId within the match (separate from clientId in case the same client rejoins matches). */
  matchPlayerId?: string;
  joinedQueueAt?: number;
  endedMatchSince?: number;
}

interface Party {
  code: string;
  hostId: string;            // ClientSession.id
  members: string[];          // ClientSession.id[] including host
  botFill: number;
  createdAt: number;
  /** True while this party's members are in an active match — blocks new code-joins. */
  inMatch: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return code;
}

export class LobbyServer {
  private httpServer = createServer((req, res) => this.handleHttp(req, res));
  private wss!: WebSocketServer;

  private clients: Map<string, ClientSession> = new Map();
  private parties: Map<string, Party> = new Map();
  private queue: string[] = [];
  private queueTimerStartedAt: number | null = null;
  private matches: Map<string, Match> = new Map();
  private clientToMatch: Map<string, string> = new Map(); // clientId → matchId
  private stats: StatsStore;

  constructor() {
    this.stats = new StatsStore(defaultStatsPath(PROJECT_ROOT));
  }

  init(port: number): void {
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnect(ws));
    // Bind to 0.0.0.0 so 127.0.0.1 (Vite proxy / direct) reaches us reliably on macOS
    // where Node's default IPv6 wildcard sometimes refuses IPv4 connections.
    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(`[Lobby] HTTP + WebSocket listening on 0.0.0.0:${port}`);
    });
    this.httpServer.on('error', (err) => {
      console.error(`[Lobby] HTTP server error:`, err);
    });
    setInterval(() => this.tick(), 1000);
  }

  // ─── Connection lifecycle ────────────────────────────────────
  private onConnect(ws: WebSocket): void {
    const clientId = uuid();
    const session: ClientSession = {
      id: clientId,
      ws,
      name: '',
      state: 'menu',
    };
    this.clients.set(clientId, session);

    ws.on('message', (data) => {
      let msg: NetMsg;
      try { msg = JSON.parse(data.toString()) as NetMsg; } catch { return; }
      this.routeMessage(session, msg);
    });

    ws.on('close', () => this.onDisconnect(session));

    const welcome: WelcomePayload = {
      clientId,
      stats: null,
      partyCapacity: PARTY_CAPACITY,
    };
    this.send(ws, { type: 'welcome', ts: Date.now(), payload: welcome });
    console.log(`[Lobby] client connected: ${clientId.slice(0, 6)} (${this.clients.size} online)`);
  }

  private onDisconnect(session: ClientSession): void {
    console.log(`[Lobby] client disconnected: ${session.id.slice(0, 6)} (state=${session.state})`);
    this.clients.delete(session.id);
    if (session.state === 'queue') {
      this.removeFromQueue(session);
    }
    if ((session.state === 'in_match' || session.state === 'match_ended') && session.matchId && session.matchPlayerId) {
      const match = this.matches.get(session.matchId);
      if (match) match.removeClient(session.matchPlayerId, false);
      this.clientToMatch.delete(session.id);
    }
    // Always drop them from any persistent party they belonged to.
    if (session.partyCode) {
      const code = session.partyCode;
      this.removeFromParty(session, /*notify*/ true);
      this.maybeClearPartyInMatch(code);
    }
  }

  // ─── Message routing ─────────────────────────────────────────
  private routeMessage(session: ClientSession, msg: NetMsg): void {
    // Lobby-scoped messages
    switch (msg.type) {
      case 'set_name':
        return this.handleSetName(session, msg);
      case 'create_party':
        return this.handleCreateParty(session, msg);
      case 'join_party':
        return this.handleJoinParty(session, msg);
      case 'leave_party':
        return this.handleLeaveParty(session);
      case 'update_party_settings':
        return this.handleUpdatePartySettings(session, msg);
      case 'start_match':
        return this.handleStartMatch(session);
      case 'queue_join':
        return this.handleQueueJoin(session, msg);
      case 'queue_leave':
        return this.handleQueueLeave(session);
      case 'solo_start':
        return this.handleSoloStart(session, msg);
      case 'return_to_menu':
        return this.handleReturnToMenu(session);
      case 'play_again':
        return this.handlePlayAgain(session);
      case 'ping':
        return this.send(session.ws, { type: 'pong', ts: Date.now(), payload: msg.payload });
    }

    // In-match messages — forward to the match
    if ((session.state === 'in_match' || session.state === 'match_ended') && session.matchId && session.matchPlayerId) {
      const match = this.matches.get(session.matchId);
      if (match) match.handleClientMessage(session.matchPlayerId, msg);
    }
  }

  // ─── Lobby handlers ──────────────────────────────────────────
  private handleSetName(session: ClientSession, msg: NetMsg): void {
    const payload = (msg.payload ?? {}) as { name?: string };
    const name = (payload.name ?? '').trim().slice(0, 24);
    if (!name) return this.lobbyError(session, 'Name cannot be empty');
    session.name = name;
    const stats = this.stats.ensure(name);
    this.sendStats(session, stats);
  }

  private handleCreateParty(session: ClientSession, _msg: NetMsg): void {
    if (!session.name) return this.lobbyError(session, 'Set a name first');
    if (session.state === 'in_match' || session.state === 'match_ended') {
      return this.lobbyError(session, 'Already in a match');
    }
    if (session.state === 'queue') this.removeFromQueue(session);
    if (session.state === 'party') this.removeFromParty(session, true);

    let code = generateCode();
    let attempts = 0;
    while (this.parties.has(code) && attempts < 10) {
      code = generateCode();
      attempts++;
    }
    if (this.parties.has(code)) return this.lobbyError(session, 'Could not create party — try again');

    const party: Party = {
      code,
      hostId: session.id,
      members: [session.id],
      botFill: PARTY_DEFAULT_BOTS,
      createdAt: Date.now(),
      inMatch: false,
    };
    this.parties.set(code, party);
    session.state = 'party';
    session.partyCode = code;
    this.broadcastLobby(party);
    console.log(`[Lobby] party ${code} created by ${session.name}`);
  }

  private handleJoinParty(session: ClientSession, msg: NetMsg): void {
    if (!session.name) return this.lobbyError(session, 'Set a name first');
    const payload = (msg.payload ?? {}) as { code?: string };
    const code = (payload.code ?? '').trim().toUpperCase();
    const party = this.parties.get(code);
    if (!party) return this.lobbyError(session, `Party ${code || '????'} not found`);
    if (party.inMatch && !party.members.includes(session.id)) {
      return this.lobbyError(session, 'Crew is already at sea — wait for them to return');
    }
    if (party.members.length >= PARTY_CAPACITY) return this.lobbyError(session, 'Party is full');
    if (session.state === 'in_match' || session.state === 'match_ended') {
      return this.lobbyError(session, 'Already in a match');
    }
    if (session.state === 'queue') this.removeFromQueue(session);
    if (session.state === 'party' && session.partyCode !== code) this.removeFromParty(session, true);
    if (party.members.includes(session.id)) {
      this.broadcastLobby(party);
      return;
    }

    party.members.push(session.id);
    session.state = 'party';
    session.partyCode = code;
    this.broadcastLobby(party);
  }

  private handleLeaveParty(session: ClientSession): void {
    if (session.state !== 'party') return;
    this.removeFromParty(session, true);
  }

  private handleUpdatePartySettings(session: ClientSession, msg: NetMsg): void {
    if (session.state !== 'party' || !session.partyCode) return;
    const party = this.parties.get(session.partyCode);
    if (!party || party.hostId !== session.id) return this.lobbyError(session, 'Only the host can change settings');
    const payload = (msg.payload ?? {}) as { botFill?: number };
    if (typeof payload.botFill === 'number' && Number.isFinite(payload.botFill)) {
      party.botFill = Math.max(0, Math.min(PARTY_MAX_BOTS, Math.floor(payload.botFill)));
    }
    this.broadcastLobby(party);
  }

  private handleStartMatch(session: ClientSession): void {
    if (session.state !== 'party' || !session.partyCode) return;
    const party = this.parties.get(session.partyCode);
    if (!party) return;
    if (party.hostId !== session.id) return this.lobbyError(session, 'Only the host can start');
    if (party.members.length === 0) return;

    // Only members currently sitting in the party panel are launched. Stragglers still on
    // last match's end-screen will rejoin via play_again.
    const memberSessions = party.members
      .map((id) => this.clients.get(id))
      .filter((c): c is ClientSession => !!c && c.state === 'party');
    if (memberSessions.length === 0) return;

    const botCount = Math.max(0, Math.min(party.botFill, MATCH_TOTAL_SHIPS - memberSessions.length));
    const match = this.spawnMatch({ botCount, source: 'party' });

    party.inMatch = true;
    for (const member of memberSessions) {
      this.placeClientIntoMatch(member, match, 'party', party.code);
    }
  }

  private handleQueueJoin(session: ClientSession, _msg: NetMsg): void {
    if (!session.name) return this.lobbyError(session, 'Set a name first');
    if (session.state === 'in_match' || session.state === 'match_ended') {
      return this.lobbyError(session, 'Already in a match');
    }
    if (session.state === 'party') this.removeFromParty(session, true);
    if (this.queue.includes(session.id)) {
      this.broadcastQueue();
      return;
    }
    this.queue.push(session.id);
    session.state = 'queue';
    session.joinedQueueAt = Date.now();
    if (this.queueTimerStartedAt === null) {
      this.queueTimerStartedAt = Date.now();
    }
    this.broadcastQueue();
    this.tryDispatchQueue();
  }

  private handleQueueLeave(session: ClientSession): void {
    if (session.state !== 'queue') return;
    this.removeFromQueue(session);
  }

  private handleSoloStart(session: ClientSession, msg: NetMsg): void {
    if (!session.name) return this.lobbyError(session, 'Set a name first');
    if (session.state === 'in_match' || session.state === 'match_ended') {
      return this.lobbyError(session, 'Already in a match');
    }
    if (session.state === 'queue') this.removeFromQueue(session);
    if (session.state === 'party') this.removeFromParty(session, true);
    const payload = (msg.payload ?? {}) as { botCount?: number };
    const requested = typeof payload.botCount === 'number' ? Math.floor(payload.botCount) : PARTY_DEFAULT_BOTS;
    const botCount = Math.max(0, Math.min(PARTY_MAX_BOTS, requested));
    const match = this.spawnMatch({ botCount, source: 'party' });
    this.placeClientIntoMatch(session, match, 'party');
  }

  private handleReturnToMenu(session: ClientSession): void {
    if (session.state !== 'in_match' && session.state !== 'match_ended') return;
    if (session.matchId && session.matchPlayerId) {
      const match = this.matches.get(session.matchId);
      if (match) match.detachClient(session.matchPlayerId);
    }
    this.clientToMatch.delete(session.id);
    session.state = 'menu';
    session.matchId = undefined;
    session.matchPlayerId = undefined;
    session.endedMatchSince = undefined;
    // Returning to main menu also exits the persistent party.
    if (session.partyCode) this.removeFromParty(session, true);
    this.maybeClearPartyInMatch(session.partyCode);
    this.send(session.ws, { type: 'lobby_left', ts: Date.now(), payload: {} });
    if (session.name) this.sendStats(session, this.stats.ensure(session.name));
  }

  /**
   * Returns the player to the party lobby they came from (if it still exists), so the host can
   * launch another match with the same crew. Falls back to main menu otherwise.
   */
  private handlePlayAgain(session: ClientSession): void {
    if (session.state !== 'in_match' && session.state !== 'match_ended') return;
    if (session.matchId && session.matchPlayerId) {
      const match = this.matches.get(session.matchId);
      if (match) match.detachClient(session.matchPlayerId);
    }
    this.clientToMatch.delete(session.id);
    session.matchId = undefined;
    session.matchPlayerId = undefined;
    session.endedMatchSince = undefined;

    const code = session.partyCode;
    const party = code ? this.parties.get(code) : undefined;
    if (!party || !party.members.includes(session.id)) {
      // Party gone — degrade to menu return.
      session.state = 'menu';
      session.partyCode = undefined;
      this.send(session.ws, { type: 'lobby_left', ts: Date.now(), payload: {} });
      if (session.name) this.sendStats(session, this.stats.ensure(session.name));
      return;
    }
    session.state = 'party';
    this.maybeClearPartyInMatch(code);
    if (session.name) this.sendStats(session, this.stats.ensure(session.name));
    this.broadcastLobby(party);
  }

  /** Clear `inMatch` once no member of the party is still in/ended a match. */
  private maybeClearPartyInMatch(code: string | undefined): void {
    if (!code) return;
    const party = this.parties.get(code);
    if (!party || !party.inMatch) return;
    const stillInMatch = party.members.some((id) => {
      const c = this.clients.get(id);
      return c?.state === 'in_match' || c?.state === 'match_ended';
    });
    if (!stillInMatch) party.inMatch = false;
  }

  // ─── Party helpers ───────────────────────────────────────────
  private removeFromParty(session: ClientSession, notifyRest: boolean): void {
    const code = session.partyCode;
    if (!code) return;
    session.partyCode = undefined;
    if (session.state === 'party') session.state = 'menu';
    const party = this.parties.get(code);
    if (!party) return;
    party.members = party.members.filter((id) => id !== session.id);
    if (party.members.length === 0) {
      this.parties.delete(code);
      console.log(`[Lobby] party ${code} destroyed (empty)`);
    } else {
      if (party.hostId === session.id) {
        party.hostId = party.members[0];
      }
      if (notifyRest) this.broadcastLobby(party);
    }
    this.send(session.ws, { type: 'lobby_left', ts: Date.now(), payload: {} });
  }

  private broadcastLobby(party: Party): void {
    const members: LobbyMember[] = party.members.map((id) => {
      const c = this.clients.get(id);
      return {
        clientId: id,
        name: c?.name || 'Pirate',
        isHost: id === party.hostId,
      };
    });
    const payload: LobbyUpdatePayload = {
      code: party.code,
      hostId: party.hostId,
      members,
      botFill: party.botFill,
      capacity: PARTY_CAPACITY,
      canStart: party.members.length >= 1,
    };
    for (const id of party.members) {
      const c = this.clients.get(id);
      if (c) this.send(c.ws, { type: 'lobby_update', ts: Date.now(), payload });
    }
  }

  // ─── Queue helpers ───────────────────────────────────────────
  private removeFromQueue(session: ClientSession): void {
    this.queue = this.queue.filter((id) => id !== session.id);
    if (session.state === 'queue') session.state = 'menu';
    session.joinedQueueAt = undefined;
    if (this.queue.length === 0) this.queueTimerStartedAt = null;
    this.send(session.ws, { type: 'lobby_left', ts: Date.now(), payload: {} });
    this.broadcastQueue();
  }

  private queueSecondsRemaining(): number {
    if (this.queueTimerStartedAt === null) return QUEUE_TIMER_SECONDS;
    const elapsed = (Date.now() - this.queueTimerStartedAt) / 1000;
    return Math.max(0, Math.ceil(QUEUE_TIMER_SECONDS - elapsed));
  }

  private broadcastQueue(starting: boolean = false): void {
    const payload: QueueUpdatePayload = {
      inQueue: this.queue.length,
      needed: QUEUE_TARGET,
      secondsRemaining: this.queueSecondsRemaining(),
      starting,
    };
    for (const id of this.queue) {
      const c = this.clients.get(id);
      if (c) this.send(c.ws, { type: 'queue_update', ts: Date.now(), payload });
    }
  }

  private tryDispatchQueue(): void {
    if (this.queue.length === 0) return;

    const seconds = this.queueSecondsRemaining();
    const have = this.queue.length;

    const fastReady = have >= QUEUE_TARGET; // full lobby — go now
    const slowReady = seconds === 0 && have >= QUEUE_MIN_HUMANS_FALLBACK;
    const enoughHumans = have >= QUEUE_MIN_HUMANS_FAST && seconds <= QUEUE_TIMER_SECONDS - 5;

    if (!fastReady && !slowReady && !enoughHumans) return;

    const cohort = this.queue.splice(0, Math.min(QUEUE_TARGET, this.queue.length));
    const cohortSessions = cohort
      .map((id) => this.clients.get(id))
      .filter((c): c is ClientSession => !!c);
    if (cohortSessions.length === 0) {
      this.queueTimerStartedAt = null;
      return;
    }

    const botCount = Math.max(0, QUEUE_MATCH_BOTS_FILL_TO - cohortSessions.length);
    const match = this.spawnMatch({ botCount, source: 'queue' });
    for (const c of cohortSessions) {
      this.placeClientIntoMatch(c, match, 'queue');
    }

    if (this.queue.length === 0) {
      this.queueTimerStartedAt = null;
    } else {
      this.queueTimerStartedAt = Date.now();
    }
    this.broadcastQueue();
  }

  // ─── Match lifecycle ─────────────────────────────────────────
  private spawnMatch(opts: { botCount: number; source: 'party' | 'queue' }): Match {
    const matchId = uuid();
    const match = new Match({ matchId, botCount: opts.botCount });
    match.onMatchEnd = (result) => this.onMatchEnd(matchId, result);
    match.start();
    this.matches.set(matchId, match);
    return match;
  }

  private placeClientIntoMatch(session: ClientSession, match: Match, source: 'party' | 'queue', partyCode: string | null = null): void {
    // Send match_start FIRST so the client tears down the menu and resets local round
    // state BEFORE the join snapshot arrives — otherwise the post-join reset wipes
    // localPlayerId/state and the camera + input lose their anchor.
    const startMsg: MatchStartPayload = {
      matchId: match.id,
      source,
      expectedHumans: match.humanCount() + 1,
      botCount: 0,
      partyCode,
    };
    this.send(session.ws, { type: 'match_start', ts: Date.now(), payload: startMsg });

    const { playerId } = match.addHumanClient(session.ws, session.name);
    session.state = 'in_match';
    session.matchId = match.id;
    session.matchPlayerId = playerId;
    session.endedMatchSince = undefined;
    this.clientToMatch.set(session.id, match.id);
  }

  private onMatchEnd(matchId: string, result: MatchEndResult): void {
    console.log(`[Lobby] match ${matchId.slice(0, 6)} ended (${result.reason}) — ${result.humans.length} humans`);

    // Persist stats for every human in the result, even ones whose ws already closed —
    // identity is by display name (the canonical key for the JSON store).
    for (const r of result.humans) {
      if (!r.name || r.name === 'Pirate') continue;
      const updated = this.stats.applyMatchResult({
        name: r.name,
        kills: r.kills,
        deaths: r.deaths,
        gold: r.gold,
        placement: r.placement,
        isWinner: r.isWinner,
      });
      const clientSession = this.findClientByPlayerId(r.playerId);
      if (clientSession) {
        this.sendStats(clientSession, updated);
        if (clientSession.state === 'in_match') {
          clientSession.state = 'match_ended';
          clientSession.endedMatchSince = Date.now();
        }
      }
    }

    this.stats.flush();
  }

  private findClientByPlayerId(playerId: string): ClientSession | null {
    for (const session of this.clients.values()) {
      if (session.matchPlayerId === playerId) return session;
    }
    return null;
  }

  // ─── Tick: queue progression + match GC ─────────────────────
  private tick(): void {
    if (this.queue.length > 0) {
      this.tryDispatchQueue();
      this.broadcastQueue();
    }

    const now = Date.now();
    for (const [matchId, match] of this.matches) {
      const endedAt = match.endedAtMs();
      if (endedAt && now - endedAt > MATCH_GC_AFTER_END_MS) {
        match.stop();
        this.matches.delete(matchId);
        // Drop client links to this match.
        for (const session of this.clients.values()) {
          if (session.matchId === matchId) {
            session.state = 'menu';
            session.matchId = undefined;
            session.matchPlayerId = undefined;
            session.endedMatchSince = undefined;
            this.clientToMatch.delete(session.id);
          }
        }
      }
    }

    // Auto-detach clients lingering on the post-match screen too long.
    for (const session of this.clients.values()) {
      if (session.state === 'match_ended' && session.endedMatchSince
          && now - session.endedMatchSince > ENDED_MATCH_DETACH_MS) {
        this.handleReturnToMenu(session);
      }
    }
  }

  // ─── Send helpers ────────────────────────────────────────────
  private send(ws: WebSocket, msg: NetMsg): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  private sendStats(session: ClientSession, stats: PlayerStatsRecord): void {
    this.send(session.ws, { type: 'stats_update', ts: Date.now(), payload: stats });
  }

  private lobbyError(session: ClientSession, reason: string): void {
    this.send(session.ws, { type: 'lobby_error', ts: Date.now(), payload: { reason } });
  }

  // ─── HTTP (static client serving) ────────────────────────────
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const rawPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (rawPath === '/health' || rawPath === '/healthz') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(JSON.stringify({
        ok: true,
        clients: this.clients.size,
        matches: this.matches.size,
        queue: this.queue.length,
      }));
      return;
    }

    if (rawPath.startsWith('/ws')) {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Upgrade Required');
      return;
    }

    if (!existsSync(join(CLIENT_DIST_ROOT, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Pirates BR WebSocket server is running. Build the client bundle or use Vite on port 3000.');
      return;
    }

    const normalizedPath = normalize(decodeURIComponent(rawPath === '/' ? '/index.html' : rawPath))
      .replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = join(CLIENT_DIST_ROOT, normalizedPath);
    if (!filePath.startsWith(CLIENT_DIST_ROOT)) {
      filePath = join(CLIENT_DIST_ROOT, 'index.html');
    } else if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(CLIENT_DIST_ROOT, 'index.html');
    }

    const ext = extname(filePath);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(res);
  }
}
