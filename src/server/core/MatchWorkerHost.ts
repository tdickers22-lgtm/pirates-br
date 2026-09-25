/**
 * MatchWorkerHost (b2.0b, critique-01, D8 lever 3): runs each Match in a
 * worker_thread so matches use every vCPU instead of sharing the lobby's one
 * event loop. One worker per vCPU (PIRATES_BR_MATCH_WORKERS: 0/unset = off,
 * N = N workers, 'auto' = availableParallelism()); a new match goes to the
 * worker hosting the fewest.
 *
 * LobbyServer keeps its synchronous call sites: it holds a MatchProxy whose
 * query methods read the mirror the worker posts every tick, whose commands
 * are posted in order on one port, and whose calls that return a value block
 * on Atomics.wait until the worker answers (between two of its ticks, a few
 * ms at most). A worker that dies or stops answering faults only the matches
 * it hosts; the lobby reaps those through the same onFault path an
 * in-process quarantine uses.
 */
import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { WebSocket } from 'ws';
import type { Match, MatchEndResult } from './Match.js';
import type { ModeId } from '../../shared/constants/index.js';
import type { GameState } from '../../shared/types/index.js';
import type { MatchMirror, SocketOp } from './matchWorker.js';
import { TICK_PHASES, type TickCost } from './TickProfiler.js';

/** The Match surface LobbyServer uses. Match and MatchProxy both satisfy it. */
export type MatchHandle = Pick<Match,
  | 'id' | 'start' | 'stop' | 'interrupt' | 'detachClient' | 'resumeClient' | 'removeClient'
  | 'takeOverBotHull' | 'retireBotHullBeforeHorn' | 'createCrew' | 'handleClientMessage'
  | 'isEnded' | 'endedAtMs' | 'isQuarantined' | 'isAwaitingHorn' | 'botCrewCount' | 'sinceHornSec'
  | 'modeId' | 'humanCount' | 'crewSize' | 'simLagSeconds' | 'droppedTickCount' | 'tickCost'
  | 'markDisconnected' | 'resumeReplay' | 'onMatchEnd' | 'onFault'>;

export interface MatchSpawnOpts { matchId: string; botCount: number; mode: ModeId }

/** How long a synchronous call may block the lobby before the worker is
 *  declared hung. A healthy worker answers between two ticks (< 20 ms), or
 *  after the world generation of a match it is still building (in-process
 *  that blocked the lobby just the same); only an infinite loop gets here. */
const SYNC_CALL_TIMEOUT_MS = 15_000;
/** A fresh worker loads the sim before it can answer anything. */
const BOOT_TIMEOUT_MS = 60_000;
/** Report a socket's backlog to its worker when it moves by this much. */
const BUFFERED_REPORT_STEP = 16 * 1024;

/** PIRATES_BR_MATCH_WORKERS -> worker count (0 = matches stay in-process). */
export function matchWorkerCountFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PIRATES_BR_MATCH_WORKERS ?? '').trim();
  if (raw === '' || raw === '0') return 0;
  if (raw === 'auto') { const n = availableParallelism(); return n > 1 ? n : 0; }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 64) : 0;
}

function workerEntry(preload?: string): { entry: string | URL; eval: boolean; execArgv: string[] } {
  const self = import.meta.url;
  // Node 20 ignores `--import` in a worker's execArgv, so a test preload (and
  // tsx in dev) is imported by an eval shim ahead of the entry.
  const pre = preload ? `import(${JSON.stringify(preload)}).then(() => ` : '';
  const preEnd = preload ? ')' : '';
  if (!self.endsWith('.ts') && preload) {
    const target = new URL('./matchWorker.js', self).href;
    return { entry: `${pre}import(${JSON.stringify(target)})${preEnd}.catch((e) => { console.error(e); process.exit(1); });`, eval: true, execArgv: process.execArgv };
  }
  if (self.endsWith('.ts')) {
    // Dev / tests run the TypeScript source through tsx. Node 20 does not apply
    // an inherited `--import tsx` to a worker's own .ts entry, so the worker
    // starts from a shim that registers tsx and then imports the entry.
    const execArgv: string[] = [];
    for (let i = 0; i < process.execArgv.length; i++) {
      const a = process.execArgv[i];
      const next = process.execArgv[i + 1] ?? '';
      if ((a === '--import' || a === '--require' || a === '--loader') && next.includes('tsx')) { i += 1; continue; }
      if (a.includes('tsx')) continue;
      execArgv.push(a);
    }
    const target = new URL('./matchWorker.ts', self).href;
    const shim = `${pre}import('tsx/esm/api')${preEnd}.then((m) => { m.register(); return import(${JSON.stringify(target)}); })`
      + `.catch((e) => { console.error(e); process.exit(1); });`;
    return { entry: shim, eval: true, execArgv };
  }
  return { entry: new URL('./matchWorker.js', self), eval: false, execArgv: process.execArgv };
}

class HostedWorker {
  readonly worker: Worker;
  readonly req: MessagePort;
  readonly ev: MessagePort;
  readonly flag: Int32Array;
  readonly proxies = new Map<string, MatchProxy>();
  dead = false;
  private nextCallId = 1;

  constructor(private readonly host: MatchWorkerHost, readonly index: number, testHooks: boolean, preload: string | undefined) {
    const reqCh = new MessageChannel();
    const evCh = new MessageChannel();
    const sab = new SharedArrayBuffer(8); // [0] reply flag, [1] worker ready
    this.flag = new Int32Array(sab);
    this.req = reqCh.port1;
    this.ev = evCh.port1;
    const { entry, eval: isEval, execArgv } = workerEntry(preload);
    this.worker = new Worker(entry, {
      eval: isEval,
      execArgv,
      workerData: { kind: 'pirates-br-match-worker', req: reqCh.port2, ev: evCh.port2, flag: sab, testHooks },
      transferList: [reqCh.port2, evCh.port2],
    });
    this.ev.on('message', (m) => this.onEvent(m));
    this.worker.on('error', (err) => this.die(`worker error: ${err instanceof Error ? err.message : String(err)}`));
    this.worker.on('exit', (code) => { if (!this.host.closing) this.die(`worker exited (${code})`); });
  }

  onEvent(msg: any): void {
    if (msg.t === 'io') { for (const op of msg.ops as SocketOp[]) this.host.applySocketOp(this, op); return; }
    const proxy = this.proxies.get(msg.matchId);
    if (!proxy) return;
    if (msg.t === 'mirror') proxy.mirror = msg.mirror as MatchMirror;
    else if (msg.t === 'end') proxy.onMatchEnd?.(msg.result as MatchEndResult);
    else if (msg.t === 'fault') proxy.onFault?.(msg.reason);
    else if (msg.t === 'gone') this.proxies.delete(msg.matchId);
  }

  /** Dispatch every event the worker queued before its latest reply. */
  drainEvents(): void {
    for (let m = receiveMessageOnPort(this.ev); m; m = receiveMessageOnPort(this.ev)) this.onEvent(m.message);
  }

  post(msg: Record<string, unknown>): void {
    if (this.dead) return;
    this.req.postMessage(msg);
  }

  callSync(k: 'call' | 'debug', matchId: string, method: string, args: unknown[]): unknown {
    if (this.dead) throw new Error(`match worker ${this.index} is down`);
    if (Atomics.load(this.flag, 1) === 0 && Atomics.wait(this.flag, 1, 0, BOOT_TIMEOUT_MS) === 'timed-out') {
      this.die(`did not boot in ${BOOT_TIMEOUT_MS} ms`);
      throw new Error(`match worker ${this.index} never booted`);
    }
    const id = this.nextCallId++;
    Atomics.store(this.flag, 0, 0);
    this.req.postMessage({ k, id, matchId, method, args });
    for (;;) {
      const woke = Atomics.wait(this.flag, 0, 0, SYNC_CALL_TIMEOUT_MS);
      if (woke === 'timed-out') {
        this.die(`${method} did not answer in ${SYNC_CALL_TIMEOUT_MS} ms`);
        throw new Error(`match worker ${this.index} hung on ${method}`);
      }
      this.drainEvents();
      if (Atomics.load(this.flag, 1) === 2) { this.die(`exited during ${method}`); throw new Error(`match worker ${this.index} exited during ${method}`); }
      const reply = receiveMessageOnPort(this.req)?.message as { id: number; ok: boolean; value?: unknown; error?: string } | undefined;
      if (!reply) { Atomics.store(this.flag, 0, 0); continue; }
      if (reply.id !== id) { Atomics.store(this.flag, 0, 0); continue; }
      if (!reply.ok) throw new Error(`match worker ${method}: ${reply.error}`);
      return reply.value;
    }
  }

  /** A worker that crashed or hung takes only its own matches with it. */
  die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    console.error(`[MatchWorkerHost] worker ${this.index} down: ${reason}; faulting ${this.proxies.size} match(es)`);
    for (const proxy of Array.from(this.proxies.values())) {
      // Sockets stay open: the lobby's reap sends each crew back to its party
      // on the same connection, exactly as for an in-process quarantine.
      proxy.mirror = { ...proxy.mirror, isQuarantined: true, endedAtMs: proxy.mirror.endedAtMs ?? Date.now() };
      proxy.onFault?.('server_fault');
    }
    this.proxies.clear();
    void this.worker.terminate().catch(() => {});
  }
}

let nextSid = 1;

export class MatchProxy implements MatchHandle {
  onMatchEnd: ((result: MatchEndResult) => void) | null = null;
  onFault: ((reason: 'server_fault') => void) | null = null;
  mirror: MatchMirror;

  constructor(readonly id: string, private readonly w: HostedWorker, private readonly host: MatchWorkerHost, mode: ModeId) {
    this.mirror = {
      endedAtMs: null, isEnded: false, isQuarantined: false, isAwaitingHorn: true, botCrewCount: 0,
      sinceHornSec: null, modeId: mode, humanCount: 0, crewSize: 1, simLagSeconds: 0, droppedTickCount: 0, tickCount: 0,
      tickCost: { n: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, phasesMs: Object.fromEntries(TICK_PHASES.map((p) => [p, 0])) as TickCost['phasesMs'] },
    };
  }

  private cast(method: string, ...args: unknown[]): void { this.w.post({ k: 'cast', matchId: this.id, method, args }); }
  private call<T>(method: string, ...args: unknown[]): T { return this.w.callSync('call', this.id, method, args) as T; }
  private sidOf(ws: WebSocket): number { return this.host.sidFor(this.w, ws); }
  private withJoinSends<T>(r: any): T {
    if (!r) return r;
    return { ...r, joins: r.joins.map(({ token, ...rest }: any) => ({ ...rest, send: () => this.w.callSync('call', this.id, 'joinSend', [token]) })) };
  }

  start(): void { this.cast('start'); }
  stop(): void { this.cast('stop'); }
  interrupt(): boolean { return this.call<boolean>('interrupt'); }
  detachClient(playerId: string): void { this.cast('detachClient', playerId); }
  removeClient(playerId: string, closeWs = false): void { this.cast('removeClient', playerId, closeWs); }
  handleClientMessage(playerId: string, msg: Parameters<Match['handleClientMessage']>[1]): void { this.cast('handleClientMessage', playerId, msg); }
  resumeClient(playerId: string, ws: WebSocket): { playerId: string; shipId: string; snapshot: GameState } | null {
    return this.call('resumeClient', playerId, this.sidOf(ws));
  }
  createCrew(members: { ws: WebSocket; name: string }[]): ReturnType<Match['createCrew']> {
    return this.withJoinSends(this.call('createCrew', members.map((m) => ({ sid: this.sidOf(m.ws), name: m.name }))));
  }
  takeOverBotHull(members: { ws: WebSocket; name: string }[]): ReturnType<Match['takeOverBotHull']> {
    return this.withJoinSends(this.call('takeOverBotHull', members.map((m) => ({ sid: this.sidOf(m.ws), name: m.name }))));
  }
  retireBotHullBeforeHorn(): boolean { return this.call<boolean>('retireBotHullBeforeHorn'); }
  markDisconnected(playerId: string): boolean { return this.call<boolean>('markDisconnected', playerId); }
  resumeReplay(playerId: string): ReturnType<Match['resumeReplay']> { return this.call('resumeReplay', playerId); }

  isEnded(): boolean { return this.mirror.isEnded; }
  endedAtMs(): number | null { return this.mirror.endedAtMs; }
  isQuarantined(): boolean { return this.mirror.isQuarantined; }
  isAwaitingHorn(): boolean { return this.mirror.isAwaitingHorn; }
  botCrewCount(): number { return this.mirror.botCrewCount; }
  sinceHornSec(): number | null { return this.mirror.sinceHornSec; }
  modeId(): ModeId { return this.mirror.modeId; }
  humanCount(): number { return this.mirror.humanCount; }
  crewSize(): number { return this.mirror.crewSize; }
  simLagSeconds(): number { return this.mirror.simLagSeconds; }
  droppedTickCount(): number { return this.mirror.droppedTickCount; }
  tickCost(): TickCost { return this.mirror.tickCost; }

  /** Test hooks (host built with testHooks): stepped clock, manual ticks, fault injection. */
  debug(op: string, ...args: unknown[]): unknown { return this.w.callSync('debug', this.id, op, args); }
  /** Test hook: hand the worker a socket without going through the lobby. */
  socketId(ws: WebSocket): number { return this.sidOf(ws); }
  get workerIndex(): number { return this.w.index; }
}

export class MatchWorkerHost {
  private readonly workers: HostedWorker[] = [];
  private readonly sockets = new Map<number, { ws: WebSocket; lastBuffered: number; workers: Set<HostedWorker> }>();
  private readonly sidByWs = new WeakMap<WebSocket, number>();
  closing = false;

  /** opts.testHooks enables MatchProxy.debug; opts.preload is a module URL each
   *  worker imports before the sim (test-only: the determinism gate's seeded
   *  id source and stepped clock). */
  constructor(readonly workerCount: number, opts: { testHooks?: boolean; preload?: string } = {}) {
    if (workerCount < 1) throw new Error('MatchWorkerHost needs at least one worker');
    for (let i = 0; i < workerCount; i++) this.workers.push(new HostedWorker(this, i, !!opts.testHooks, opts.preload));
  }

  /** Spread: the live worker hosting the fewest matches. */
  createMatch(opts: MatchSpawnOpts): MatchProxy {
    const live = this.workers.filter((w) => !w.dead);
    if (live.length === 0) throw new Error('every match worker is down');
    const w = live.reduce((a, b) => (b.proxies.size < a.proxies.size ? b : a));
    const proxy = new MatchProxy(opts.matchId, w, this, opts.mode);
    w.proxies.set(opts.matchId, proxy);
    w.post({ k: 'new', opts: { matchId: opts.matchId, botCount: opts.botCount, mode: opts.mode } });
    return proxy;
  }

  sidFor(w: HostedWorker, ws: WebSocket): number {
    let sid = this.sidByWs.get(ws);
    if (sid === undefined) {
      sid = nextSid++;
      this.sidByWs.set(ws, sid);
      const entry = { ws, lastBuffered: 0, workers: new Set<HostedWorker>() };
      this.sockets.set(sid, entry);
      const id = sid;
      const onClose = () => {
        for (const hw of entry.workers) hw.post({ k: 'sock', sid: id, closed: true });
        this.sockets.delete(id);
      };
      if (typeof (ws as { once?: unknown }).once === 'function') ws.once('close', onClose);
    }
    this.sockets.get(sid)?.workers.add(w);
    return sid;
  }

  applySocketOp(w: HostedWorker, op: SocketOp): void {
    const entry = this.sockets.get(op.sid);
    if (!entry) return;
    const ws = entry.ws;
    if (op.op === 'close') { try { ws.close(op.code, op.reason); } catch {} return; }
    if (ws.readyState !== 1) return;
    try { ws.send(typeof op.data === 'string' ? op.data : Buffer.from(op.data)); } catch {}
    const buffered = ws.bufferedAmount ?? 0;
    if (Math.abs(buffered - entry.lastBuffered) >= BUFFERED_REPORT_STEP || (buffered === 0) !== (entry.lastBuffered === 0)) {
      entry.lastBuffered = buffered;
      w.post({ k: 'sock', sid: op.sid, buffered });
    }
  }

  matchCount(): number { return this.workers.reduce((n, w) => n + w.proxies.size, 0); }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.worker.terminate().catch(() => 0)));
  }
}
