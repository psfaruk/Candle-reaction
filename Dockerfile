# syntax=docker/dockerfile:1
# ============================================================
# QX ক্যান্ডেল রিয়াকশন সিগন্যাল ইঞ্জিন — Railway / Docker image
# ZERO-CONFIG deploy:
#   • Railway injects PORT → the engine binds it automatically
#   • DB auto-locates to /data (volume) or /app/db (ephemeral)
#   • Schema is self-bootstrapped by the Python engine at start
#   • No environment variables required at all
#
# Architecture (single public port):
#   engine (Python: aiohttp + socket.io @ /engine)  ←  public $PORT
#     ├── /engine/*   → socket.io (realtime market data + RPC)
#     ├── /qx-health  → liveness/readiness probe (200 JSON)
#     └── everything else → proxied to Next.js standalone (:3001 internal)
# ============================================================

# ---- build stage: node for a fully-supported `next build` ----
FROM node:22-slim AS build
RUN npm install -g bun
WORKDIR /app

# root deps first (layer cache)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# sources
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npx next build \
 && cp -r .next/static .next/standalone/.next/ \
 && cp -r public .next/standalone/

# ---- runtime stage: Python runs the engine, node runs Next.js ----
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Python engine venv + dependencies (built once, baked into the image)
WORKDIR /app
COPY mini-services/qx-engine/requirements.txt /tmp/qx-requirements.txt
RUN python3 -m venv /opt/qxvenv \
 && /opt/qxvenv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/qxvenv/bin/pip install --no-cache-dir -r /tmp/qx-requirements.txt

COPY --from=build /app/.next/standalone ./.next/standalone
COPY --from=build /app/public ./public
COPY mini-services ./mini-services
COPY deploy ./deploy
RUN chmod +x deploy/start.sh mini-services/qx-engine/run.sh && mkdir -p /data /app/db

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV QX_NEXT_PORT=3001
CMD ["bash", "deploy/start.sh"]
