/**
 * Match worker (b2.0b, critique-01, D8 lever 3). The sim is single-threaded
 * Node, so a second vCPU buys nothing while every Match ticks on the lobby's
 * event loop. MatchWorkerHost starts one of these per vCPU and spreads matches
 * across them; each worker owns its Match instances outright (their tick
 * interval, rng, world) and talks to the lobby through two ports:
 *
 *   req  (lobby -> worker, in order): new / call / cast / sock / debug. A
 *        `call` is answered on the same port, then the shared flag is flipped
 *        so the lobby's Atomics.wait returns (the lobby's call sites stay
 *        synchronous, as they were in-process).
 *   ev   (worker -> lobby): socket I/O batches, per-match mirrors of the state
 *        the lobby queries synchronously, match end and fault.
 *
 * Ordering: socket I/O queued during a call is flushed on `ev` BEFORE the
 * reply is posted, and the lobby drains `ev` before it applies the reply, so a
 * client sees frames in the order the in-process Match would have sent them.
 */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import type { WebSocket } from 'ws';
import { Match } from './Match.js';
import { SERVER_TICK_MS } from '../../shared/constants/index.js';
import type { ModeId } from '../../shared/constants/index.js';

export interface MatchMirror {
  endedAtMs: number | null;
  isEnded: boolean;
  isQuarantined: boolean;
  isAwaitingHorn: boolean;
  botCrewCount: number;
  sinceHornSec: number | null;
  modeId: ModeId;
  humanCount: number;
  crewSize: number;
  simLagSeconds: number;
  droppedTickCount: number;
  tickCount: number;
}

/** One socket operation the lobby replays on the real ws. */
export type SocketOp =
  | { sid: number; op: 'send'; data: string | ArrayBuffer }
  | { sid: number; op: 'close'; code?: number; reason?: string };

export interface WorkerInit {
  req: MessagePort;
  ev: MessagePort;
  flag: SharedArrayBuffer;
  testHooks: boolean;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/** The ws surface Match uses (readyState / bufferedAmount / send / close),
 *  backed by the lobby's real socket on the other side of the port. */
class PortSocket {
  static readonly CONNECTING = WS_CONNECTING;
  static readonly OPEN = WS_OPEN;
  static readonly CLOSING = WS_CLOSING;
  static readonly CLOSED = WS_CLOSED;
  readyState = WS_OPEN;
  bufferedAmount = 0;
  constructor(readonly sid: number, private readonly io: (op: SocketOp, transfer?: ArrayBuffer) => void) {}
  send(data: unknown): void {
    if (this.readyState !== WS_OPEN) return;
    if (typeof data === 'string') { this.io({ sid: this.sid, op: 'send', data }); return; }
    let view: Uint8Array;
    if (data instanceof ArrayBuffer) view = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else { this.io({ sid: this.sid, op: 'send', data: String(data) }); return; }
    // Copy into an ArrayBuffer we own, then TRANSFER it: no second copy on the port.
    const ab = new ArrayBuffer(view.byteLength);
    new Uint8Array(ab).set(view);
    this.io({ sid: this.sid, op: 'send', data: ab }, ab);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState >= WS_CLOSING) return;
    this.readyState = WS_CLOSING;
    this.io({ sid: this.sid, op: 'close', code, reason });
  }
  on(): this { return this; }
  once(): this { return this; }
  off(): this { return this; }
  removeListener(): this { return this; }
  ping(): void {}
  terminate(): void { this.close(1006, 'terminated'); }
}

type JoinSend = () => unknown;

function mirrorOf(m: Match): MatchMirror {
  return {
    endedAtMs: m.endedAtMs(),
    isEnded: m.isEnded(),
    isQuarantined: m.isQuarantined(),
    isAwaitingHorn: m.isAwaitingHorn(),
    botCrewCount: m.botCrewCount(),
    sinceHornSec: m.sinceHornSec(),
    modeId: m.modeId(),
    humanCount: m.humanCount(),
    crewSize: m.crewSize(),
    simLagSeconds: m.simLagSeconds(),
    droppedTickCount: m.droppedTickCount(),
    tickCount: (m as unknown as { tickCount: number }).tickCount ?? 0,
  };
}

export function runMatchWorker(init: WorkerInit): void {
  const { req, ev, testHooks } = init;
  const flag = new Int32Array(init.flag);
  const matches = new Map<string, Match>();
  const sockets = new Map<number, PortSocket>();
  const joinSends = new Map<number, JoinSend>();
  let nextJoinToken = 1;
  const lastMirror = new Map<string, string>();

  let outbox: SocketOp[] = [];
  let outTransfer: ArrayBuffer[] = [];
  let flushArmed = false;
  const flushIo = () => {
    flushArmed = false;
    if (outbox.length === 0) return;
    const ops = outbox; const transfer = outTransfer;
    outbox = []; outTransfer = [];
    ev.postMessage({ t: 'io', ops }, transfer);
  };
  const io = (op: SocketOp, transfer?: ArrayBuffer) => {
    outbox.push(op);
    if (transfer) outTransfer.push(transfer);
    if (!flushArmed) { flushArmed = true; setImmediate(flushIo); }
  };
  const socketFor = (sid: number): PortSocket => {
    let s = sockets.get(sid);
    if (!s) { s = new PortSocket(sid, io); sockets.set(sid, s); }
    return s;
  };
  const postMirror = (matchId: string, force = false) => {
    const m = matches.get(matchId);
    if (!m) return;
    const mirror = mirrorOf(m);
    const key = JSON.stringify(mirror);
    if (!force && lastMirror.get(matchId) === key) return;
    lastMirror.set(matchId, key);
    ev.postMessage({ t: 'mirror', matchId, mirror });
  };
  const wrapJoins = <T extends { joins: { send: JoinSend }[] }>(r: T | null) => {
    if (!r) return null;
    return {
      ...r,
      joins: r.joins.map(({ send, ...rest }) => {
        const token = nextJoinToken++;
        joinSends.set(token, send);
        return { ...rest, token };
      }),
    };
  };
  const members = (list: { sid: number; name: string }[]) =>
    list.map((m) => ({ ws: socketFor(m.sid) as unknown as WebSocket, name: m.name }));

  // Test-only stepped clock: the determinism gate preloads the same clock on
  // both sides (globalThis.__pbrClockStep) so the ts fields line up.
  const stepClock = () => {
    const step = (globalThis as { __pbrClockStep?: (ms: number) => void }).__pbrClockStep;
    if (typeof step === 'function') step(SERVER_TICK_MS);
  };

  function call(matchId: string, method: string, args: unknown[]): unknown {
    const m = matches.get(matchId);
    if (method === 'joinSend') {
      const token = args[0] as number;
      const send = joinSends.get(token);
      joinSends.delete(token);
      return send ? send() : null;
    }
    if (!m) throw new Error(`no match ${matchId} in this worker`);
    switch (method) {
      case 'createCrew': return wrapJoins(m.createCrew(members(args[0] as { sid: number; name: string }[])));
      case 'takeOverBotHull': return wrapJoins(m.takeOverBotHull(members(args[0] as { sid: number; name: string }[])));
      case 'resumeClient': return m.resumeClient(args[0] as string, socketFor(args[1] as number) as unknown as WebSocket);
      case 'interrupt': return m.interrupt();
      case 'retireBotHullBeforeHorn': return m.retireBotHullBeforeHorn();
      case 'markDisconnected': return m.markDisconnected(args[0] as string);
      case 'resumeReplay': return m.resumeReplay(args[0] as string);
      default: throw new Error(`unknown match call ${method}`);
    }
  }

  function cast(matchId: string, method: string, args: unknown[]): void {
    const m = matches.get(matchId);
    if (!m) return;
    switch (method) {
      case 'start': m.start(); break;
      case 'stop': m.stop(); matches.delete(matchId); lastMirror.delete(matchId); ev.postMessage({ t: 'gone', matchId }); return;
      case 'detachClient': m.detachClient(args[0] as string); break;
      case 'removeClient': m.removeClient(args[0] as string, args[1] as boolean); break;
      case 'handleClientMessage': m.handleClientMessage(args[0] as string, args[1] as Parameters<Match['handleClientMessage']>[1]); break;
      default: throw new Error(`unknown match cast ${method}`);
    }
  }

  function debug(matchId: string, op: string, args: unknown[]): unknown {
    if (!testHooks) throw new Error('match worker test hooks are off');
    const m = matches.get(matchId) as unknown as Record<string, any> | undefined;
    if (op === 'crashWorker') process.exit(1); // ends this worker thread only
    if (!m) throw new Error(`no match ${matchId}`);
    switch (op) {
      case 'addHuman': return m.addHumanClient(socketFor(args[0] as number), args[1] as string);
      case 'forcePlaying':
        m.state.phase = 'playing'; m.countdownRemaining = 0; m.state.countdownRemaining = 0; return true;
      case 'step': {
        const n = args[0] as number;
        for (let i = 0; i < n; i++) { stepClock(); m.tick(); }
        return m.tickCount;
      }
      case 'injectTickFault':
        m.updateCaptures = () => { throw new Error('injected tick fault (test-match-worker)'); };
        return true;
      case 'tickCount': return m.tickCount;
      // b2.0c perf-server-load --workers: the same mid-match fast-forward,
      // rebase and per-tick timing the in-process load run does on the lobby
      // thread, run where the match lives. Chunked by wall time so no single
      // call nears SYNC_CALL_TIMEOUT_MS.
      case 'loadFastForward': {
        const [ffSec, budgetMs] = args as [number, number];
        if (!m.__ffMuted) {
          // enforceCongestion runs on sim time: 300 sim s against a socket the
          // blocked lobby cannot drain evicted the match's own load crew.
          m.__ffMuted = ['broadcast', 'broadcastVolatile', 'send', 'enforceCongestion'].filter((f) => typeof m[f] === 'function');
          for (const f of m.__ffMuted) m[f] = () => {};
          m.__ffTicks = 0; m.__ffMs = 0;
        }
        const t0 = performance.now();
        const cap = Math.ceil((ffSec + 60) * 1000 / SERVER_TICK_MS);
        let done = false;
        while (performance.now() - t0 < budgetMs) {
          done = m.__ffTicks >= cap || (m.state.phase === 'playing' && m.t >= ffSec) || m.state.phase === 'ended';
          if (done) break;
          m.tick(); m.__ffTicks += 1;
        }
        m.__ffMs += performance.now() - t0;
        const row = { t: m.t, phase: m.state.phase, ticks: m.__ffTicks, ffMs: m.__ffMs, ships: m.state.ships?.length ?? 0, alive: m.state.shipsAlive ?? m.state.ships?.length ?? 0, done };
        if (done) { for (const f of m.__ffMuted) delete m[f]; m.__ffMuted = null; }
        return row;
      }
      // The load crew shares the lobby thread, which sits in Atomics.wait
      // through another match's fast-forward: its socket cannot drain, and that
      // is the harness, not a player. Capacity rows grade the sim.
      case 'loadNoEvict': { m.enforceCongestion = () => {}; return true; }
      case 'loadRebase': {
        const wall = Date.now(); const perf = performance.now();
        if (m.state.phase === 'playing') m.playingSinceWallMs = wall - m.t * 1000;
        m.tickBacklogSec = 0; m.lastTickWallMs = perf; m.droppedTicks = 0;
        if (!m.__timed) {
          const tick = m.tick.bind(m);
          m.__tickMs = [];
          m.tick = (...a: unknown[]) => { const s0 = performance.now(); try { return tick(...a); } finally { m.__tickMs.push(performance.now() - s0); } };
          m.__timed = true;
        }
        m.__tickMs.length = 0;
        m.__lag0 = m.simLagSeconds();
        return true;
      }
      case 'loadStats': {
        const xs = [...(m.__tickMs ?? [])].sort((x: number, y: number) => x - y);
        const q = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
        return { p50: q(0.5), p99: q(0.99), n: xs.length, lagGrowth: m.simLagSeconds() - (m.__lag0 ?? 0), dropped: m.droppedTickCount() };
      }
      default: throw new Error(`unknown debug op ${op}`);
    }
  }

  req.on('message', (msg: any) => {
    if (msg.k === 'new') {
      const m = new Match(msg.opts);
      const matchId: string = msg.opts.matchId;
      m.onMatchEnd = (result) => ev.postMessage({ t: 'end', matchId, result });
      m.onFault = (reason) => { postMirror(matchId, true); ev.postMessage({ t: 'fault', matchId, reason }); };
      matches.set(matchId, m);
      postMirror(matchId, true);
    } else if (msg.k === 'sock') {
      const s = sockets.get(msg.sid);
      if (msg.closed) { if (s) s.readyState = WS_CLOSED; sockets.delete(msg.sid); }
      else if (s && typeof msg.buffered === 'number') s.bufferedAmount = msg.buffered;
    } else if (msg.k === 'cast') {
      try { cast(msg.matchId, msg.method, msg.args); } catch (err) { console.error('[matchWorker] cast failed:', err); }
      postMirror(msg.matchId);
    } else if (msg.k === 'call' || msg.k === 'debug') {
      let reply: { ok: true; value: unknown } | { ok: false; error: string };
      try {
        const value = msg.k === 'call' ? call(msg.matchId, msg.method, msg.args) : debug(msg.matchId, msg.method, msg.args);
        reply = { ok: true, value };
      } catch (err) {
        reply = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) };
      }
      if (msg.matchId && matches.has(msg.matchId)) postMirror(msg.matchId, true);
      flushIo();
      req.postMessage({ id: msg.id, ...reply });
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    }
  });

  // Mirrors ride the tick rate: the lobby's dispatch reads them synchronously
  // and a mirror at most one tick old is what an in-process read raced anyway.
  setInterval(() => { for (const id of matches.keys()) postMirror(id); }, SERVER_TICK_MS).unref();
  Atomics.store(flag, 1, 1);
  Atomics.notify(flag, 1);
  // A dying worker wakes a lobby blocked in a call at once (flag[1] = 2 = gone).
  process.on('exit', () => { Atomics.store(flag, 1, 2); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); });
}

if (parentPort && workerData && (workerData as { kind?: string }).kind === 'pirates-br-match-worker') {
  runMatchWorker(workerData as WorkerInit);
}
