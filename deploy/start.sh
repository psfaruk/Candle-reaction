#!/bin/bash
# ============================================================
# QX signal app — container entrypoint (ZERO-CONFIG, self-healing)
#
#  1) auto-pick SQLite location: /data (Railway volume) → /app/db
#     (schema is self-bootstrapped by the Python engine — no prisma push)
#  2) start Next.js standalone on $PORT (PUBLIC)
#     → src/instrumentation.ts (inside the Next server) spawns the
#       Python qx-engine on :3003 automatically, and next.config.ts
#       rewrites /engine + /qx-health to it.
#     → this works NO MATTER HOW the app is started: even if the host
#       ignores this script and runs `next start` / `node server.js`
#       directly, the engine still boots via instrumentation.
#  3) supervise Next: if it dies, restart it automatically
#
# Railway injects $PORT — nothing needs to be configured manually.
# ============================================================
set -u

PORT="${PORT:-3000}"

# repo root (works no matter where the container CWD is)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { echo "[start $(date -u +%H:%M:%S)] $*"; }

# ---------- 1) database location (fully automatic) ----------
DB_DIR=""
if [ -d /data ] || mkdir -p /data 2>/dev/null; then
  if touch /data/.writetest 2>/dev/null && rm -f /data/.writetest 2>/dev/null; then
    DB_DIR="/data"
  fi
fi
if [ -z "$DB_DIR" ]; then
  mkdir -p /app/db 2>/dev/null || true
  DB_DIR="/app/db"
  log "⚠ /data not writable — using ephemeral /app/db (attach a Railway volume at /data for persistence)"
fi
DB_FILE="${DB_DIR}/qx.db"
export DATABASE_URL="${DATABASE_URL:-file:${DB_FILE}}"
export QX_ENGINE_PORT="${QX_ENGINE_PORT:-3003}"
log "database → ${DATABASE_URL} | engine (internal) → :${QX_ENGINE_PORT} | public → :${PORT}"

# ---------- 2) Next.js standalone on the PUBLIC $PORT ----------
NEXT_RUNTIME="node"
command -v node >/dev/null 2>&1 || NEXT_RUNTIME="bun"

start_next() {
  PORT="$PORT" HOSTNAME=0.0.0.0 QX_ENGINE_PORT="$QX_ENGINE_PORT" \
    DATABASE_URL="$DATABASE_URL" \
    "$NEXT_RUNTIME" .next/standalone/server.js &
  NEXT_PID=$!
  log "next.js standalone → :${PORT} via ${NEXT_RUNTIME} (pid $NEXT_PID) — engine auto-spawns inside"
}

start_next

# wait for the app (and with it the engine routes) to answer
(
  for i in $(seq 1 60); do
    if "$NEXT_RUNTIME" -e "require('http').get('http://127.0.0.1:${PORT}/qx-health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
      log "✅ app + engine are answering on :${PORT} (/qx-health)"
      exit 0
    fi
    sleep 1
  done
  log "⚠ /qx-health did not answer within 60s — check logs above"
) &

# ---------- 3) supervisor: restart Next if it dies ----------
shutdown() {
  log "SIGTERM/SIGINT received — stopping..."
  kill "$NEXT_PID" 2>/dev/null || true
  pkill -f "python3 main.py" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

log "🚀 supervisor running (next :${PORT} public, engine :${QX_ENGINE_PORT} internal via instrumentation, health /qx-health)"
while true; do
  sleep 5
  if ! kill -0 "$NEXT_PID" 2>/dev/null; then
    log "⚠ next.js died — restarting"
    start_next
  fi
done
