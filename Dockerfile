# Pirates BR: single-service image (the Node WS game server also serves the built client).
# Fly:   fly deploy --remote-only --ha=false --build-arg BUILD_ID=$(git rev-parse --short=12 HEAD)
#        (the exact runbook is DEPLOY.md; the Air has no local Docker daemon)
# Local: docker build --build-arg BUILD_ID=$(git rev-parse --short=12 HEAD) -t pirates-br .
#        docker run -p 8090:8090 -v pbr-data:/app/data pirates-br   -> http://localhost:8090
#
# Why 8090 and never 8080: local content filters (seen on macOS) replay the first
# client TCP segment on 8080 and kill every WebSocket with an RSV1 error.
# Base pinned to bookworm-slim: the entrypoint needs setpriv (util-linux).

# ── Stage 1: build client bundle + compile server ──────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
# devDependencies include playwright (test harness only); never fetch its browsers here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# The build context has no .git, so the build id comes in as a build-arg (the git
# sha from DEPLOY.md / deploy.yml). vite.config.ts bakes it into the bundle and
# postbuild-compress copies it to dist/build-id.txt for the server's welcome, so a
# client on an older build reloads (versionGate). Unset -> a timestamp id.
ARG BUILD_ID=""
ENV BUILD_ID=${BUILD_ID}
# tsc(server) -> dist/server, tsc(client typecheck), vite build -> dist/client, br/gz siblings
RUN npm run build

# ── Stage 2: lean runtime (production deps + compiled output only) ──────────
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8090
ARG BUILD_ID=""
ENV BUILD_ID=${BUILD_ID}
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Fail the build (not the boot) if the base ever loses setpriv.
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && command -v setpriv \
 && mkdir -p /app/data && chown -R node:node /app/data
# StatsStore writes /app/data/stats.json. On Fly the pirates_data volume mounts here
# root-owned, so the entrypoint chowns it at boot and then drops to user node.
# The image deliberately has no USER line: the entrypoint must start as root for
# that chown, and it execs the server as node (it never runs the server as root).
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
