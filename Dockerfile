# Pirates BR — single-service image (Node WS game server also serves the built client).
# Build: docker build -t pirates-br .
# Run:   docker run -p 8080:8080 pirates-br   → open http://localhost:8080

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
ENV PORT=8080
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# StatsStore persists here; ephemeral unless you mount a volume at /app/data
RUN mkdir -p data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
