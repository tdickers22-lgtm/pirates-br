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

/**
 * GRACEFUL DRAIN ON SIGTERM (ONLINE-01 phase 1 / RECON-01, netcode-29).
 *
 * SIGTERM is what Fly, Render and Kubernetes send before replacing a machine.
 * Node's default for it is an immediate exit, so every deploy hung up on every
 * live match with a 1006 — indistinguishable, from the player's side, from
 * their own wifi dropping, and the seat-hold path would park seats for a
 * process that is never coming back. LobbyServer.shutdown flips /health to 503
 * first (the edge stops routing here), gives live matches their grace, then
 * closes with 1012 "server restarting", which the client reads as "reload".
 *
 * A SECOND signal exits at once: a drain that has itself wedged must not be
 * the reason a deploy cannot finish.
 */
const DRAIN_MS = Math.max(0, Number(process.env.PIRATES_BR_DRAIN_SECONDS ?? 10) * 1000) || 0;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) { process.exit(0); return; }
    stopping = true;
    console.log(`[server] ${signal} — draining for up to ${DRAIN_MS / 1000}s`);
    server.shutdown(signal, DRAIN_MS)
      .catch((err) => console.error('[server] drain failed:', err))
      .finally(() => process.exit(0));
  });
}

server.init(port);
