# Pirates BR — single-service image (Node WS game server also serves the built client).
# Build: docker build -t pirates-br .
# Run:   docker run -p 8090:8090 pirates-br   → open http://localhost:8090
#
# Why 8090 and not the old default: local content filters (seen on macOS) replay the
# first client TCP segment on that port and kill every WebSocket with an RSV1 error,
# so an image mapped there cannot be smoke-tested where it was built (DEPLOY.md).
# Platforms that inject PORT (Railway, Render) override this anyway.

# ── Stage 1: build client bundle + compile server ──────────────────────────
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# tsc(server) → dist/server, tsc(client typecheck), vite build → dist/client (+ public assets)
RUN npm run build

# ── Stage 2: lean runtime (production deps + compiled output only) ──────────
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8090
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# StatsStore persists here; ephemeral unless you mount a volume at /app/data
RUN mkdir -p data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
