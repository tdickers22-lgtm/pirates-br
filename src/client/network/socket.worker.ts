/**
 * The game socket, moved off the main thread.
 *
 * WHY THIS EXISTS
 * Loading into a match pins the main thread: the join snapshot builds the whole
 * world, and islands keep streaming in for tens of seconds afterwards. While the
 * main thread is pinned two things stop happening, and BOTH of them read to the
 * server as a dead player:
 *
 *  1. The app-level heartbeat timer (`ping` every 3s) never fires.
 *  2. Chromium's WebSocket applies receive backpressure. A renderer that is not
 *     consuming `onmessage` fills the pipe, the network service stops reading the
 *     TCP socket, and inbound frames — INCLUDING the server's ws PING — are never
 *     parsed. So the browser's "automatic" pong never goes out either. A live
 *     match pushes ~31 hot snapshots a second, so the pipe fills in well under a
 *     second of stall.
 *
 * The server refreshes `lastSeenAt` at the top of its `message` handler for every
 * inbound frame, and drops a socket silent past its budget. Measured: a 35s
 * main-thread stall after join earned a `[Net] Disconnected (code 1006)` with the
 * match channel shut — a permanent, reload-only death mid-game.
 *
 * A worker fixes both halves at once, and it has to be the worker that OWNS the
 * socket rather than a worker that merely nudges the main thread to send: a
 * pinned main thread cannot send anything, however loudly it is asked to. Here
 * the beat comes from a thread that never blocks, and the same thread drains
 * `onmessage` continuously so the flow-control pipe never backs up and the
 * automatic pongs keep flowing.
 *
 * Frames are relayed to the main thread as RAW STRINGS — parsing stays where the
 * handlers are, so nothing about message routing or the hostile-frame contract
 * changes, and no snapshot pays for a structured clone.
 */

/** One heartbeat beat. Five of these fit inside the server's 15s silence budget. */
const HEARTBEAT_INTERVAL_MS = 3_000;

/**
 * How many relayed frames may be in flight to a main thread that has not
 * acknowledged them before we start coalescing snapshots.
 *
 * Without this, a 20s stall hands the main thread ~600 queued snapshots the
 * instant it wakes up, and it parses every one of them (~40MB of JSON) before it
 * can draw a frame — the stall extends itself. Above the threshold only the
 * NEWEST snapshot of each kind is kept, which is exactly what the client already
 * does with its own rAF coalescing slots, so nothing is lost that would have
 * been rendered. Everything that is not a snapshot (join, kill_event, pong, the
 * whole lobby channel) is relayed immediately, always: those carry meaning that
 * does not supersede.
 */
const MAX_UNACKED_FRAMES = 6;

/** Cheap type sniff on the head of the frame. The server writes `type` first
 *  (`JSON.stringify({ type, ts, payload })`), so this needs no parse. If that
 *  ever changes, coalescing simply stops happening — frames still all arrive. */
const SNAPSHOT_HEAD = /^\{"type":"(state_hot|state_snapshot)"/;

type ToWorker =
  | { k: 'open'; url: string }
  | { k: 'send'; data: string }
  | { k: 'ack'; n: number }
  | { k: 'close' };

type FromWorker =
  | { k: 'open' }
  | { k: 'msg'; data: string; n: number; receivedAt: number }
  | { k: 'closed'; code: number; reason: string }
  | { k: 'failed' };

let socket: WebSocket | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let sent = 0;
let acked = 0;
/** Newest held frame per coalesced kind, waiting for the main thread to catch up. */
const held = new Map<string, { raw: string; receivedAt: number }>();

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

function stopBeat(): void {
  if (beat === null) return;
  clearInterval(beat);
  beat = null;
}

/** Relay a frame, coalescing superseded snapshots while the main thread is behind. */
function relay(raw: string): void {
  // Stamp on the thread that actually received the socket frame. The renderer
  // may be pinned for seconds before it drains this message; stamping there
  // would turn its own delay into alleged server slowdown.
  const receivedAt = Date.now();
  const behind = sent - acked > MAX_UNACKED_FRAMES;
  const kind = behind ? SNAPSHOT_HEAD.exec(raw)?.[1] : undefined;
  if (kind) {
    held.set(kind, { raw, receivedAt });
    return;
  }
  if (held.size > 0) flushHeld();
  post({ k: 'msg', data: raw, n: ++sent, receivedAt });
}

function flushHeld(): void {
  // Full before hot: a hot snapshot patches onto the last full one, so releasing
  // them in the other order would apply the patch and then throw it away.
  for (const kind of ['state_snapshot', 'state_hot']) {
    const frame = held.get(kind);
    if (frame === undefined) continue;
    held.delete(kind);
    post({ k: 'msg', data: frame.raw, n: ++sent, receivedAt: frame.receivedAt });
  }
}

function openSocket(url: string): void {
  closeSocket();
  sent = 0;
  acked = 0;
  held.clear();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    post({ k: 'failed' });
    return;
  }
  socket = ws;
  ws.onopen = () => {
    post({ k: 'open' });
    // Beat once immediately: a client that opens the socket and then sits on the
    // name field should count as alive from the first second, not the third.
    sendPing();
    stopBeat();
    beat = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') relay(e.data);
  };
  ws.onerror = () => {
    // 'error' is always followed by 'close'; report only if we never opened, so
    // the main thread's connect() promise can reject instead of hanging.
    if (ws.readyState !== WebSocket.OPEN) post({ k: 'failed' });
  };
  ws.onclose = (e) => {
    stopBeat();
    held.clear();
    if (socket === ws) socket = null;
    post({ k: 'closed', code: e.code, reason: e.reason });
  };
}

/**
 * The heartbeat itself. Timing is done here with the worker's own clock, so the
 * `pong` echo still measures a true round trip — Date.now() is the same wall
 * clock on both threads.
 */
function sendPing(): void {
  const ts = Date.now();
  rawSend(JSON.stringify({ type: 'ping', ts, payload: { t: ts } }));
}

function rawSend(data: string): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(data); } catch { /* the close handler owns the fallout */ }
}

function closeSocket(): void {
  stopBeat();
  held.clear();
  const ws = socket;
  socket = null;
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try { ws.close(); } catch { /* already gone */ }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.k) {
    case 'open': openSocket(m.url); break;
    case 'send': rawSend(m.data); break;
    case 'ack':
      // Monotonic: a stale ack must never walk the watermark backwards.
      if (m.n > acked) acked = m.n;
      if (held.size > 0 && sent - acked <= MAX_UNACKED_FRAMES) flushHeld();
      break;
    case 'close': closeSocket(); break;
  }
};
