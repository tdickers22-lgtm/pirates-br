# Deploying Pirates BR

Pirates BR is a **single service**: the Node WebSocket game server (`dist/server/index.js`)
also serves the built client bundle (`dist/client`). Client and game socket share one
origin — the browser connects to `wss://<host>/ws` automatically over HTTPS.

**Requirements for the host:**
- Node 20+ (or Docker)
- **WebSocket support** (Fly, Render, Railway, Heroku, Fly, a VPS — all fine)
- Reads the `PORT` env var (the server already does; defaults to 8080)
- Health check path: `GET /health` → `200 {"ok":true,...}`

Stats (`data/stats.json`) are written at runtime and are **ephemeral** unless you mount a
persistent volume at `/app/data`. The game runs fine without persistence (leaderboard resets).

---

## Bare Node (VPS / local)

```bash
npm ci
npm run build          # tsc(server) + vite build → dist/
PORT=8080 npm start    # node dist/server/index.js  → http://localhost:8080
```

## Docker (any host)

```bash
docker build -t pirates-br .
docker run -p 8080:8080 pirates-br      # → http://localhost:8080
# persist stats:  docker run -p 8080:8080 -v pbr-data:/app/data pirates-br
```

## Fly.io  (Dockerfile auto-detected)

```bash
fly launch --no-deploy      # generates fly.toml; set internal_port = 8080
fly deploy
```
Ensure `fly.toml` has `[http_service] internal_port = 8080` and `force_https = true`
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
