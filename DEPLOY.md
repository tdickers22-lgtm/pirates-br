# Deploying Pirates BR

Pirates BR is a **single service**: the Node WebSocket game server (`dist/server/index.js`)
also serves the built client bundle (`dist/client`). Client and game socket share one
origin — the browser connects to `wss://<host>/ws` automatically over HTTPS.

**Requirements for the host:**
- Node 20+ (or Docker)
- **WebSocket support** (Fly, Render, Railway, Heroku, a VPS — all fine)
- Reads the `PORT` env var. The server, the Dockerfile and every recipe below default to
  **8090**. Never 8080: local content filters (seen on macOS) replay the first client TCP
  segment on that port and corrupt every WebSocket handshake with an RSV1 error, so an
  image mapped to that host port cannot even be smoke-tested where it was built.
- Health check path: `GET /health` → `200 {"ok":true,...}`. Load-balance on
  **`accepting`**, not on the status code: a FULL host is still healthy (its eight live
  matches must keep their players) and answers `200 {"accepting": false}`. Only a host that
  is DRAINING answers `503`, and that is the one an orchestrator should replace.

Stats (`data/stats.json`) are written at runtime and are **ephemeral** unless you mount a
persistent volume at `/app/data`. The game runs fine without persistence (leaderboard resets).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8090` | Listen port (HTTP + `/ws`). |
| `PIRATES_BR_DEV` | unset | `1` opens `POST /bugsnap` (F8 bug reports) outright. Never set on a public host. |
| `PIRATES_BR_DEV_HOOKS` | unset | `1` enables the in-match dev hooks (`dev_grant_gold`, `dev_bot_peace`); a match that used one is flagged `devAssisted` and kept out of stats. Never set on a public host. |
| `BUGSNAP_KEY` | unset | Lets a client with header `X-Bugsnap-Key: <key>` post bug snaps to a production host. Without it (and without `PIRATES_BR_DEV`) `/bugsnap` is a 404. |
| `BUGSNAP_DIR` | `data/bugsnaps` | Where snaps land; the server keeps the newest 50 and takes one per IP per 10 s. |
| `PIRATES_BR_MAX_MATCHES` | `8` | How many matches this process will carry. The (N+1)th crew is refused with "This host is full" from a lobby that is still responsive, and `/health` reports `accepting: false` so a fleet in front routes elsewhere. `0` disables the ceiling. Measure your own box with `node --import tsx scripts/perf-server-load.mjs` (see below) before raising it. |
| `PIRATES_BR_TRUST_PROXY` | unset | `1` attributes requests to the left-most `x-forwarded-for` hop instead of the socket. **Set this on any host behind a proxy or edge** (Fly, Render, Railway, nginx): without it every player shares the edge's address, so the `/bugsnap` per-IP throttle collapses to one report per 10 s for the whole internet. **Never set it on a directly exposed host** — the header is client-supplied and would become a forgeable identity. |
| `PIRATES_BR_MAP_SEED` | unset | Pins the world roll; reported by `/health` as `mapSeed`. |

`npm run dev` sets both `PIRATES_BR_DEV=1` and `PIRATES_BR_DEV_HOOKS=1` (local play keeps F8 snaps and the hooks); `npm start` sets neither.

**Process safety.** A malformed request (bad percent-encoding, unparseable URL) is answered
`400`; a throw inside a join or a lobby timer is logged and the server keeps serving; the
failed player is told and can queue again. After 5 fatal errors in 60 s the server closes
every socket with `1012 server restarting` and exits so your platform restarts it. Run it
under something that restarts on exit (Docker `HEALTHCHECK` + restart policy, Fly, Render,
Railway all do).

---

## Bare Node (VPS / local)

```bash
npm ci
npm run build          # tsc(server) + vite build → dist/
PORT=8090 npm start    # node dist/server/index.js  → http://localhost:8090
```

## Docker (any host)

```bash
docker build -t pirates-br .
docker run -p 8090:8090 pirates-br      # → http://localhost:8090
# persist stats:  docker run -p 8090:8090 -v pbr-data:/app/data pirates-br
```

## Fly.io  (Dockerfile auto-detected)

```bash
fly launch --no-deploy      # generates fly.toml; set internal_port = 8090
fly deploy
```
Ensure `fly.toml` has `[http_service] internal_port = 8090` and `force_https = true`
(WebSockets ride the same HTTPS service — no extra config).

## Railway  (Dockerfile auto-detected)

```bash
railway init
railway up
```
Railway injects `PORT` automatically; the server honors it. Enable the public domain.

## Render  (Docker)

New **Web Service** → connect the repo → Render detects the `Dockerfile`.
- Health check path: `/health`
- No build/start command needed (Docker `CMD` runs `node dist/server/index.js`)
- Or, without Docker: Build `npm ci && npm run build`, Start `npm start`.

---

### Notes
- The client bundle is ~290 kB gzipped (app + three.js). All 21 GLB assets ship inside
  `dist/client/assets/models/` (copied from `public/` by Vite at build time).
- Only prod deps (`ws`, `uuid`, `simplex-noise`, `three`) are needed at runtime; the
  Docker runtime stage installs with `--omit=dev`.


## Capacity, drain and the proxy (ONLINE-01)

**One process is not one match.** `PIRATES_BR_MAX_MATCHES` (default 8) is the ceiling, and
it exists because a host degrades by dropping ticks for *everybody at once*: the ninth
match does not make the ninth game bad, it makes all nine slow. Above the ceiling a crew
gets a refusal message from a responsive lobby instead of a broken game.

Measure the ceiling for the box you are actually deploying to:

```bash
PIRATES_BR_LOAD_MATCHES=8 node --import tsx scripts/perf-server-load.mjs
```

It stands N solo matches up on one process, runs them, and reads `worstSimLagSec` off
`/health`. The budget is **0.1 s**; on the author's fanless MacBook Air, 8 matches settle at
**0.01-0.02 s with 0 dropped ticks**, so 8 is a conservative default for anything bigger.
Raise `PIRATES_BR_MAX_MATCHES` only after the run stays under budget at the new N.

**Draining.** `SIGTERM` (what Fly, Render and Kubernetes send before replacing a machine)
now starts a graceful drain: `/health` flips to `503` immediately so the edge stops routing
new players here, no disconnected seat is held for a process that is not coming back, live
matches get `PIRATES_BR_DRAIN_SECONDS` (default 10) to finish, and only then are sockets
closed with 1012 "server restarting". A second `SIGTERM` exits at once.

**Behind an edge.** Set `PIRATES_BR_TRUST_PROXY=1` on Fly/Render/Railway/nginx. See the
environment table for why it is off by default.

### fly.toml

`fly.toml` in the repo root is a working starting point: one shared-cpu-2x machine, health
check on `/health`, `PIRATES_BR_TRUST_PROXY=1`, a 30 s kill timeout so the drain has room,
and `auto_stop_machines = false` (a machine with a live match must never be stopped for
being idle at the HTTP layer).
