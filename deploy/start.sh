#!/bin/bash
# ============================================================
# QX signal app — container entrypoint (ZERO-CONFIG, self-healing)
#
#  1) auto-pick SQLite location: /data (Railway volume) → /app/db
#  2) auto-create/patch schema (prisma db push, node-run, 3 retries)
#  3) start Next.js standalone on :3001 (node, internal)
#  4) start qx-engine on $PORT (bun, public) — proxies web → Next
#  5) supervise both: if either dies, restart it automatically
#
# Railway injects $PORT — nothing needs to be configured manually.
# ============================================================
set -u

PORT="${PORT:-3000}"
INTERNAL_PORT="${QX_NEXT_PORT:-3001}"
DB_DIR=""
DB_FILE=""

log() { echo "[start $(date -u +%H:%M:%S)] $*"; }

# ---------- 1) database location (fully automatic) ----------
if [ -d /data ] || mkdir -p /data 2>/dev/null; then
  if touch /data/.writetest 2>/dev/null && rm -f /data/.writetest 2>/dev/null; then
    DB_DIR="/data"
  fi
fi
if [ -z "$DB_DIR" ]; then
  mkdir -p /app/db
  DB_DIR="/app/db"
  log "⚠ /data not writable — using ephemeral /app/db (attach a Railway volume at /data for persistence)"
fi
DB_FILE="${DB_DIR}/qx.db"
export DATABASE_URL="${DATABASE_URL:-file:${DB_FILE}}"
log "database → ${DATABASE_URL}"

# ---------- 2) schema push (retries, node-run prisma CLI) ----------
PRISMA_CLI="node_modules/prisma/build/index.js"
if [ ! -f "$PRISMA_CLI" ]; then
  log "⚠ prisma CLI not found at $PRISMA_CLI — falling back to bunx"
  PRISMA_CLI=""
fi

push_schema() {
  if [ -n "$PRISMA_CLI" ]; then
    node "$PRISMA_CLI" db push --skip-generate --accept-data-loss --schema prisma/schema.prisma
  else
    bunx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma
  fi
}

SCHEMA_OK=0
for attempt in 1 2 3; do
  if push_schema; then
    SCHEMA_OK=1
    log "✅ prisma schema pushed (attempt ${attempt})"
    break
  fi
  log "⚠ prisma db push failed (attempt ${attempt}/3) — retrying in 3s..."
  sleep 3
done
if [ "$SCHEMA_OK" -ne 1 ]; then
  log "❌ schema push failed 3× — engine may crash-loop until DB is writable; continuing anyway"
fi

# ---------- 3) Next.js standalone (internal) ----------
# prefer node (most battle-tested); fall back to bun on images without node
NEXT_RUNTIME="node"
command -v node >/dev/null 2>&1 || NEXT_RUNTIME="bun"

start_next() {
  PORT="$INTERNAL_PORT" HOSTNAME=0.0.0.0 "$NEXT_RUNTIME" .next/standalone/server.js &
  NEXT_PID=$!
  log "next.js standalone → :${INTERNAL_PORT} via ${NEXT_RUNTIME} (pid $NEXT_PID)"
}

# ---------- 4) qx-engine (public $PORT) ----------
start_engine() {
  # engine deps resolve from root node_modules when the engine's own
  # node_modules is absent (e.g. Nixpacks installs root deps only)
  ( cd mini-services/qx-engine \
    && QX_ENGINE_PORT="$PORT" QX_NEXT_PORT="$INTERNAL_PORT" \
       DATABASE_URL="$DATABASE_URL" bun index.ts ) &
  ENGINE_PID=$!
  log "qx-engine → 0.0.0.0:${PORT} (pid $ENGINE_PID)"
}

start_next
start_engine

# wait for next to answer (info only — engine proxies meanwhile)
# NOTE: use $NEXT_RUNTIME for the probe — curl is not present in slim images
(
  for i in $(seq 1 60); do
    if "$NEXT_RUNTIME" -e "require('http').get('http://127.0.0.1:${INTERNAL_PORT}/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
      log "✅ next.js is answering on :${INTERNAL_PORT}"
      exit 0
    fi
    sleep 1
  done
  log "⚠ next.js did not answer within 60s — check logs above"
) &

# ---------- 5) supervisor: restart dead children ----------
shutdown() {
  log "SIGTERM/SIGINT received — stopping children..."
  kill "$NEXT_PID" "$ENGINE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

log "🚀 supervisor running (next :${INTERNAL_PORT} internal, engine :${PORT} public, health /qx-health)"
while true; do
  sleep 5
  if ! kill -0 "$NEXT_PID" 2>/dev/null; then
    log "⚠ next.js died — restarting"
    start_next
  fi
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    log "⚠ qx-engine died — restarting"
    start_engine
  fi
done
