import { LobbyServer } from './core/LobbyServer.js';

/** Default game-server port. 8080 is a magnet for local proxies/content filters
 *  (one such filter replays the first client TCP segment into the stream, which
 *  kills every WebSocket on that port with an RSV1 error), so the default lives
 *  on 8090. PORT still wins for deploys that pin a port. */
const DEFAULT_PORT = 8090;
const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const server = new LobbyServer();

/** Process-level last line of defence. Node's default for an uncaught
 *  exception is to exit, which on a game host means every live match ends
 *  because one request, one timer or one join hit a bug. The handlers below
 *  LOG and keep serving. A process that keeps faulting is not healthy though:
 *  past FATAL_BUDGET faults inside FATAL_WINDOW_MS the lobby stops every match
 *  cleanly (1012 "server restarting", not a silent 1006) and exits so the
 *  supervisor (Docker HEALTHCHECK / platform restart) can bring a fresh one. */
const FATAL_BUDGET = 5;
const FATAL_WINDOW_MS = 60_000;
const fatalStamps: number[] = [];
let stopping = false;

function onFatal(kind: string, err: unknown): void {
  const now = Date.now();
  fatalStamps.push(now);
  while (fatalStamps.length > 0 && now - fatalStamps[0] > FATAL_WINDOW_MS) fatalStamps.shift();
  console.error(`[fatal] ${kind} (${fatalStamps.length}/${FATAL_BUDGET} in ${FATAL_WINDOW_MS / 1000}s):`,
    err instanceof Error ? (err.stack ?? err.message) : err);
  if (fatalStamps.length >= FATAL_BUDGET && !stopping) {
    stopping = true;
    try { server.emergencyStop(`${fatalStamps.length} fatals in ${FATAL_WINDOW_MS / 1000}s`); } catch {}
    setTimeout(() => process.exit(1), 250).unref();
  }
}

process.on('uncaughtException', (err) => onFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason));

server.init(port);
