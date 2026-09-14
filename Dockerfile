# syntax=docker/dockerfile:1
# ============================================================
# QX ক্যান্ডেল রিয়েকশন সিগন্যাল ইঞ্জিন — Railway / Docker image
# ZERO-CONFIG deploy:
#   • Railway injects PORT → the engine binds it automatically
#   • DB auto-locates to /data (volume) or /app/db (ephemeral)
#   • Schema is pushed automatically at container start
#   • No environment variables required at all
#
# Architecture (single public port):
#   engine (bun, socket.io @ /engine)  ←  public $PORT
#     ├── /qx-health   → liveness/readiness probe (200 JSON)
#     └── everything else → proxied to Next.js standalone (:3001 internal)
# ============================================================

# ---- build stage: node for a fully-supported `next build` ----
FROM node:22-slim AS build
RUN npm install -g bun
WORKDIR /app

# root deps first (layer cache)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# engine deps (own package.json + lock, self-contained)
COPY mini-services/qx-engine/package.json mini-services/qx-engine/bun.lock ./mini-services/qx-engine/
RUN cd mini-services/qx-engine && bun install --frozen-lockfile

# sources (engine node_modules ships along — pure-JS deps only)
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npx next build \
 && cp -r .next/static .next/standalone/.next/ \
 && cp -r public .next/standalone/

# ---- runtime stage: bun runs the TS engine, node runs the Next server ----
FROM oven/bun:1
# node binary for battle-tested Next.js standalone + Prisma CLI execution
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./.next/standalone
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/mini-services ./mini-services
COPY --from=build /app/package.json ./package.json
COPY deploy ./deploy
RUN chmod +x deploy/start.sh && mkdir -p /data /app/db

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV QX_NEXT_PORT=3001
CMD ["bash", "deploy/start.sh"]
