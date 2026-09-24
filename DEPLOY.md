# Deploying Pirates BR

Pirates BR is a **single service**: the Node WebSocket game server (`dist/server/index.js`)
also serves the built client (`dist/client`). Client and game socket share one origin; the
browser connects to `wss://<host>/ws` over HTTPS.

The production host is **Fly.io**: app `pirates-br`, region `yyz`, ONE `performance-1x` / 2 GB
machine with the `pirates_data` volume at `/app/data`. Public URL `https://pirates-br.fly.dev`.
`scripts/test-deploy-config.mjs` grades `fly.toml`, the `Dockerfile`, the entrypoint and this
file; run it after any edit to them.

> **ONE MACHINE, ALWAYS.** Parties, resume tokens and the public queue live in one process's
> memory. With two machines behind the proxy a friend's party code lands on the other box and
> reconnects lose their seat. Every deploy line carries `--ha=false`, the volume pins the app to
> one machine, and nobody raises the machine count above one until fly-replay routing ships
> (b5.5d). Never run Fly's app-generator command either: it rewrites the committed `fly.toml`.
> The app is created with `fly apps create`.

## Launch runbook (Fly, exact)

The owner signs in once (step 1). Agents run the rest only when their lane prompt authorises
authenticated `fly` (PLAN rule 8). The Air has no local Docker daemon: builds use Fly's remote
builder (`--remote-only`).

Steps 2-8 are one resumable program: `node scripts/fly-launch.mjs` (b1.3c). It grades each side
effect (one machine, the VM size, a passing check, the volume attached, a green smoke, the soak
budget) and stops with exit 3 when an owner step is needed (O1 sign-in, O2 billing). Resume with
`--from <step>`; `--dry-run` prints the plan; `--self-test` checks the pure parts offline. The
soak step keeps HEALTH_KEY in `~/.config/pirates-br/fly-<app>.env` (0600), because Fly never hands
a secret back. The commands below are what it runs.

1. **Sign in (owner, once).** `fly auth login`, sign in in the browser tab it opens.
   Check: `fly auth whoami` prints his email.
2. **Create the app.**
   `cd ~/ai-dev-system/projects/pirates-br && fly apps create pirates-br`
   If the name is taken: `fly apps create pirates-br-game`, then in `fly.toml` set
   `app = "pirates-br-game"` and change `PIRATES_BR_PUBLIC_URL` and `PIRATES_BR_ALLOWED_ORIGINS`
   to `https://pirates-br-game.fly.dev` in the same commit (test-deploy-config checks they agree),
   and use `-a pirates-br-game` below.
3. **Create the stats volume (once).**
   `fly volumes create pirates_data --region yyz --size 1 --yes -a pirates-br`
4. **Secrets.**
   `fly secrets set HEALTH_KEY=$(openssl rand -hex 16) BUGSNAP_KEY=$(openssl rand -hex 24) -a pirates-br --stage`
   Everything else lives in `fly.toml [env]` (PORT, PIRATES_BR_PUBLIC_URL,
   PIRATES_BR_ALLOWED_ORIGINS, PIRATES_BR_TRUST_PROXY, PIRATES_BR_MAX_MATCHES,
   PIRATES_BR_DRAIN_SECONDS) and the Dockerfile (NODE_ENV=production). Never set
   PIRATES_BR_DEV or PIRATES_BR_DEV_HOOKS on this host.
5. **Deploy.**
   `fly deploy --remote-only --ha=false --build-arg BUILD_ID=$(git rev-parse --short=12 HEAD) -a pirates-br`
6. **Status.** `fly status -a pirates-br`: exactly 1 machine, `performance-1x`, state
   `started`, check passing. `fly volumes list -a pirates-br`: `pirates_data` attached to it.
7. **Smoke.** `node scripts/smoke-online.mjs --url https://pirates-br.fly.dev` exits 0 (b1.3b:
   static + brotli, `/health` machineId stable over 20 requests, wss welcome with the deployed
   buildId, solo match join, inputs to snapshots, public queue to a match, party create + join).
8. **Capacity soak (after every deploy gate, PLAN rule 11).** Run the 10-minute remote soak
   (`smoke-online --soak N --minutes 10`, b1.3b/c) past any burst window; take the largest N with
   `worstSimLagSec < 0.1` and dropped ticks < 1%, set `PIRATES_BR_MAX_MATCHES` to that N with 30%
   headroom (floor), run `node --import tsx scripts/test-capacity-sim.mjs` for the humans figure at
   that value, stamp the **Capacity record** row below with the measured commit, commit
   `fly.toml` + `DEPLOY.md`, and redeploy with step 5.
9. **CI deploy path (b1.3d), after step 4 has run once.** The `release` branch exists on
   `origin` (created at the campaign baseline `f5fee97e`, which has no workflow, so it deployed
   nothing). Tokens and keys go through pipes, never onto the screen or into a file in the repo:

   ```sh
   APP=$(sed -nE "s/^app *= *['\"]([^'\"]+)['\"].*/\1/p" fly.toml | head -1)
   fly tokens create deploy -a "$APP" -x 8760h | gh secret set FLY_API_TOKEN -R tdickers22-lgtm/pirates-br
   grep '^HEALTH_KEY=' ~/.config/pirates-br/fly-$APP.env | cut -d= -f2- | gh secret set HEALTH_KEY -R tdickers22-lgtm/pirates-br
   gh secret list -R tdickers22-lgtm/pirates-br            # both names listed
   ```

   `.github/workflows/deploy.yml` then deploys every push to `release`: resolve the app from
   `fly.toml`, record the image serving now, wait-idle, then
   `flyctl deploy --remote-only --ha=false --build-arg BUILD_ID=${{ github.sha }}`, then the smoke
   (with `HEALTH_KEY`), then a redeploy of the recorded image on a red smoke. Prove it in this order:

   - **Dry run first.** `git push origin <sha>:refs/tags/deploy-dryrun-<sha8>` (a tag, because
     `workflow_dispatch` only works once the workflow is on the default branch `main`, which it
     is not; once it is, `gh workflow run deploy.yml --ref release -f dry_run=true` does the same).
     It deploys nothing, forces the smoke red and prints the image the rollback would redeploy.
     Grade it: `node scripts/ci-rollback-dryrun.mjs --run <run id>` (the rollback must name the
     image that was serving).
   - **Then the real path.** `git push origin <green sha>:release`, wait for the run, then
     `node scripts/ci-rollback-dryrun.mjs --run <run id>`: conclusion success, deploy success,
     `PASS smoke-online` against that sha, rollback skipped.

   Offline, `node scripts/ci-rollback-dryrun.mjs` executes the workflow's own step scripts with
   fake `flyctl`/`node` for seven scenarios (dry run by dispatch and by tag, red and green real
   deploys, first deploy with no rollback target, a destroyed machine listed first) and fails if
   a dry run could deploy or the rollback could pick any image but the one that was serving.
10. **Rollback by hand.** `fly releases -a pirates-br --image` lists the images; then
    `fly deploy --image <previous image ref> --ha=false -a pirates-br`.

**Backups.** Fly snapshots the volume daily (5-day retention; `fly volumes snapshots list <vol-id>`).
A copy on demand: `fly ssh sftp get /app/data/stats.json ./stats-backup.json -a pirates-br`.

## Capacity record

The top row is the one in force. `test-deploy-config` fails when `fly.toml`'s
`PIRATES_BR_MAX_MATCHES` exceeds it, when `machine` is not the `fly.toml` VM size, when
`worstSimLagSec >= 0.1`, and when `measuredAtCommit` is older than the last commit touching
`src/server` or `src/shared` (so every deploy gate re-measures). `unmeasured` is allowed only at
the provisional MAX_MATCHES 2 and never under `--require-measured` (the live block).
`humans` = mean concurrent humans the queue holds at p95 wait <= 30 s, from
`test-capacity-sim` at that MAX_MATCHES (0 = even 1 lone player/min waits longer than 30 s at p95).

| machine | MAX_MATCHES | measuredAtCommit | worstSimLagSec | humans at p95 wait <= 30 s | date | note |
|---|---|---|---|---|---|---|
| performance-1x | 2 | unmeasured | - | 0 | 2026-09-23 | provisional until b1.3c's remote soak. test-capacity-sim at d3663698, MAX_MATCHES 2: p95 wait 239 s at 1 lone player/min (6.7 mean humans), so the D8 bar needs MAX_MATCHES >= 4 (p95 20 s). Shortfall: at 2 matches the queue shows position + ETA at peaks, never an error. |

Queue model at this commit (`node --import tsx scripts/test-capacity-sim.mjs`, 60 min x 7 seeds,
70/30 Solo/Duos, late join truce 150 s / pressure 475 s):

| arrivals/min | MAX_MATCHES | p95 wait (s) | mean humans | peak humans | lobby_error |
|---|---|---|---|---|---|
| 1 | 2 | 239 | 6.7 | 14 | 0 |
| 1 | 4 | 20 | 6.8 | 15 | 0 |
| 1 | 6 | 20 | 7.5 | 18 | 0 |
| 2 | 2 | 2345 | 13.3 | 27 | 0 |
| 2 | 4 | 66 | 14.1 | 29 | 0 |
| 2 | 6 | 20 | 14.8 | 35 | 0 |
| 3 | 2 | 3868 | 16.0 | 30 | 0 |
| 3 | 4 | 278 | 21.6 | 39 | 0 |
| 3 | 6 | 20 | 19.8 | 32 | 0 |

**Lever ladder** when the measured value misses the bar (D8): late join + pressure window
(shipped, b1.2h), cheaper ticks (b2.1h), match worker threads (b2.0b-c) and only then
performance-2x / 4 GB after the owner's yes (O6), fly-replay scale-out (b5.5d).

**Match worker threads (lever 3, b2.0b-c).** `PIRATES_BR_MATCH_WORKERS = "auto"` is in `fly.toml`:
one worker_thread per vCPU, and 0 (matches on the lobby thread, exactly as before) on a 1-vCPU
machine, so it does nothing on performance-1x and turns on by itself on performance-2x. The gate is
`node --import tsx scripts/perf-server-load.mjs --scaling 2` (in-process `--report`, then
`--report --workers 2`, two fresh processes; bar: >= 1.8x the single-thread match count at
`worstSimLagSec < 0.1`). `node --import tsx scripts/test-capacity-sim.mjs --deployed` grades the D8
bar at the MAX_MATCHES `fly.toml` ships (red at the provisional 2 by design). Local runs on the Air
(8 cores, other sessions loading it; not a Fly measurement, never stamped into the table above):

| run | commit | threads | maxMatches (worstSimLagSec < 0.1) | load1 | date |
|---|---|---|---|---|---|
| `--report` | 96214750 | 1 (in-process) | 4 (5th: lag 1.27 s, 144 dropped) | 6.8 | 2026-09-24 |

Moving to performance-2x is owner step O6 (about $62/month instead of about $31/month) and only
after the app exists (O2). On a yes: `fly scale vm performance-2x --memory 4096 -a pirates-br`, then
`fly ssh console -C "node --import tsx scripts/perf-server-load.mjs --report"` (workers come from
the env), set `PIRATES_BR_MAX_MATCHES` to the result with 30% headroom, run
`test-capacity-sim --deployed`, and add the new top row to the capacity record.

## Environment

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `PORT` | fly.toml | `8090` | Listen port (HTTP + `/ws`). Never 8080 (this Mac's content filter corrupts WebSockets there). |
| `PIRATES_BR_PUBLIC_URL` | fly.toml | unset | The public origin; read by the runbook and the smoke scripts. |
| `PIRATES_BR_ALLOWED_ORIGINS` | fly.toml | unset (any) | Comma-separated origins allowed to open `/ws`. Must contain the public URL. |
| `PIRATES_BR_TRUST_PROXY` | fly.toml | unset | `1` attributes requests to the left-most `x-forwarded-for` hop. Set it behind any edge (Fly, Render, nginx), never on a directly exposed host (the header is client-supplied). |
| `PIRATES_BR_MAX_MATCHES` | fly.toml | `8` | Matches this process carries. Above it a crew queues with position + ETA and `/health` reports `accepting: false`. On Fly it comes from the Capacity record above. |
| `PIRATES_BR_DRAIN_SECONDS` | fly.toml | `10` | Seconds a SIGTERM'd host gives its live matches before closing sockets with 1012. `kill_timeout` must be >= this + 10 s. |
| `PIRATES_BR_MAX_CLIENTS` / `_MAX_SOCKETS_PER_IP` / `_NEW_SOCKETS_PER_MIN` | code | `400` / `8` / `20` | Public-internet socket limits. |
| `HEALTH_KEY` | secret | unset | `/health` detail (and `/health/beacons`, `/health/telemetry`) needs header `X-Health-Key`. Public `/health` stays slim. |
| `BUGSNAP_KEY` | secret | unset | Lets a client with `X-Bugsnap-Key: <key>` post bug snaps; without it (and without `PIRATES_BR_DEV`) `/bugsnap` is a 404. |
| `BUGSNAP_DIR` | code | `data/bugsnaps` | Where snaps land (on the volume); newest 50 kept. |
| `PIRATES_BR_STATS_PATH` | code | `data/stats.json` | Stats file (on the volume). |
| `BUILD_ID` | build-arg | git sha or timestamp | Baked into the bundle and `dist/build-id.txt`; clients on another build reload. |
| `FLY_MACHINE_ID` | Fly | set by Fly | Reported by `/health` as `machineId`; the smoke asserts one value. |
| `PIRATES_BR_MAP_SEED` | unset | unset | Pins the world roll; reported by `/health` as `mapSeed`. |
| `PIRATES_BR_DEV` / `PIRATES_BR_DEV_HOOKS` | never on Fly | unset | Local play only (`npm run dev` sets both): F8 bug snaps and in-match dev hooks. |

## Capacity, drain and the proxy

**One process is not one match.** `PIRATES_BR_MAX_MATCHES` exists because a host degrades by
dropping ticks for everybody at once: the extra match does not make one game bad, it makes all of
them slow. The sim is single-threaded Node, so one dedicated core is the unit that matters; a
shared-cpu VM is forbidden (its pooled quota is 12.5% of a core for shared-cpu-2x, and one combat
match needs about 25%). The old default of 8 was measured on an M-series laptop, not on a Fly
vCPU; it does not apply to Fly.

**Draining.** `SIGTERM` (what Fly sends before replacing a machine) starts a graceful drain:
`/health` flips to `503` so the edge stops routing new players here, live matches get
`PIRATES_BR_DRAIN_SECONDS`, then sockets close with 1012 "server restarting". A second `SIGTERM`
exits at once. `fly.toml` keeps `kill_timeout = "30s"` as a TOP-LEVEL key: written after a
`[table]` header it silently belongs to that table and Fly falls back to its 5 s default.

**Health.** Load-balance on `accepting`, not on the status code: a FULL host is healthy and answers
`200 {"accepting": false}`. Only a DRAINING host answers `503`.

**Process safety.** A malformed request is answered `400`; a throw inside a join or a lobby timer
is logged and the server keeps serving. After 5 fatal errors in 60 s the server closes every socket
with 1012 and exits so Fly restarts it.

## The image

- `Dockerfile`: two stages on `node:20-bookworm-slim`. The build stage sets
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (playwright is a test-only devDependency), takes
  `--build-arg BUILD_ID`, and runs `npm run build` (server tsc, client typecheck, vite build,
  brotli/gzip siblings). The runtime stage has production deps and `dist/` only.
- `scripts/docker-entrypoint.sh` starts as root only to `chown` the mounted volume (Fly mounts it
  root-owned), then `exec setpriv` drops to user `node`; it exits rather than run the server as
  root. `exec` keeps SIGTERM going straight to the drain.
- `.dockerignore` keeps `.git`, `node_modules`, `dist`, `data`, docs, CI config and the Blender
  scripts out of the build context.
- Size today: `dist/client` is about 64 MB (122 GLBs with their `.br`/`.gz` siblings); the JS
  entry is split into the app, three.js and two workers.

## Other hosts

Bare Node: `npm ci && npm run build && PORT=8090 npm start`. Any Docker host:
`docker build --build-arg BUILD_ID=$(git rev-parse --short=12 HEAD) -t pirates-br .` then
`docker run -p 8090:8090 -v pbr-data:/app/data pirates-br`. Render and Railway detect the
Dockerfile and inject `PORT`; set `PIRATES_BR_TRUST_PROXY=1`, `PIRATES_BR_ALLOWED_ORIGINS` and a
measured `PIRATES_BR_MAX_MATCHES` there too, and run exactly one instance.
