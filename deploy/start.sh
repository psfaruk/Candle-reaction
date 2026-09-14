#!/bin/sh
# QX signal app — container entrypoint
# 1) create/patch the SQLite schema (persistent Railway volume at /data)
# 2) start Next.js standalone on :3001 (internal)
# 3) start the qx-engine on $PORT (public) — it proxies web traffic to Next
set -e

export DATABASE_URL="${DATABASE_URL:-file:/data/qx.db}"
mkdir -p /data

echo "[start] prisma db push → ${DATABASE_URL}"
bunx prisma db push --accept-data-loss

echo "[start] launching: next(:3001, internal) + qx-engine(:${PORT:-3000}, public)"
PORT=3001 HOSTNAME=0.0.0.0 bun .next/standalone/server.js &

( cd mini-services/qx-engine \
  && QX_ENGINE_PORT="${PORT:-3000}" QX_NEXT_PORT=3001 bun index.ts ) &

wait -n
exit $?
