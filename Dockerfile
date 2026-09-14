# syntax=docker/dockerfile:1
# ============================================================
# QX ক্যান্ডেল রিয়েকশন সিগন্যাল ইঞ্জিন — Railway / Docker image
# Architecture (single public port):
#   engine (bun, socket.io @ /engine)  ←  public $PORT
#     └── proxies non-/engine traffic → Next.js standalone (:3001)
# ============================================================

# ---- build stage: node for a fully-supported `next build` ----
FROM node:20-slim AS build
RUN npm install -g bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npx next build \
 && cp -r .next/static .next/standalone/.next/ \
 && cp -r public .next/standalone/

# ---- runtime stage: bun runs the TS engine + next standalone ----
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./.next/standalone
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/mini-services ./mini-services
COPY --from=build /app/package.json ./package.json
COPY deploy ./deploy
RUN mkdir -p /data
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV QX_NEXT_PORT=3001
EXPOSE 3000
CMD ["sh", "deploy/start.sh"]
