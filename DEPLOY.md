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
- Health check path: `GET /health` → `200 {"ok":true,...}`

Stats (`data/stats.json`) are written at runtime and are **ephemeral** unless you mount a
persistent volume at `/app/data`. The game runs fine without persistence (leaderboard resets).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8090` | Listen port (HTTP + `/ws`). |
| `PIRATES_BR_DEV` | unset | `1` enables developer-only surfaces: `POST /bugsnap` (F8 bug reports) and dev hooks. Never set on a public host. |
| `BUGSNAP_KEY` | unset | Lets a client with header `X-Bugsnap-Key: <key>` post bug snaps to a production host. Without it (and without `PIRATES_BR_DEV`) `/bugsnap` is a 404. |
| `BUGSNAP_DIR` | `data/bugsnaps` | Where snaps land; the server keeps the newest 50 and takes one per IP per 10 s. |

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
