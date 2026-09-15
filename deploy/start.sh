#!/bin/bash
# ============================================================
# QX signal app — container entrypoint (ZERO-CONFIG, self-healing)
#
#  1) auto-pick SQLite location: /data (Railway volume) → /app/db
#     (schema is self-bootstrapped by the Python engine — no prisma push)
#  2) start Next.js standalone on :3001 (node, internal)
#  3) start qx-engine (Python) on $PORT (public) — socket.io + /qx-health
#     + reverse-proxies web traffic to Next; run.sh restarts it forever
#  4) supervise both: if either dies, restart it automatically
#
# Railway injects $PORT — nothing needs to be configured manually.
# ============================================================
set -u

PORT="${PORT:-3000}"
INTERNAL_PORT="${QX_NEXT_PORT:-3001}"

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
  mkdir -p /app/db
  DB_DIR="/app/db"
  log "⚠ /data not writable — using ephemeral /app/db (attach a Railway volume at /data for persistence)"
fi
DB_FILE="${DB_DIR}/qx.db"
export DATABASE_URL="${DATABASE_URL:-file:${DB_FILE}}"
log "database → ${DATABASE_URL}"

# ---------- 2) Next.js standalone (internal) ----------
NEXT_RUNTIME="node"
command -v node >/dev/null 2>&1 || NEXT_RUNTIME="bun"

start_next() {
  PORT="$INTERNAL_PORT" HOSTNAME=0.0.0.0 "$NEXT_RUNTIME" .next/standalone/server.js &
  NEXT_PID=$!
  log "next.js standalone → :${INTERNAL_PORT} via ${NEXT_RUNTIME} (pid $NEXT_PID)"
}

# ---------- 3) qx-engine (Python, public $PORT) ----------
start_engine() {
  (
    cd mini-services/qx-engine \
      && QX_ENGINE_PORT="$PORT" QX_NEXT_PORT="$INTERNAL_PORT" \
         DATABASE_URL="$DATABASE_URL" bash run.sh
  ) &
  ENGINE_PID=$!
  log "qx-engine (python) → 0.0.0.0:${PORT} (pid $ENGINE_PID)"
}

start_next
start_engine

# wait for the engine to answer (readiness proof)
(
  for i in $(seq 1 60); do
    if "$NEXT_RUNTIME" -e "require('http').get('http://127.0.0.1:${PORT}/qx-health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
      log "✅ qx-engine is answering on :${PORT}"
      exit 0
    fi
    sleep 1
  done
  log "⚠ engine did not answer within 60s — check logs above"
) &

# ---------- 4) supervisor: restart dead children ----------
shutdown() {
  log "SIGTERM/SIGINT received — stopping children..."
  kill "$NEXT_PID" "$ENGINE_PID" 2>/dev/null || true
  pkill -f "python3 main.py" 2>/dev/null || true
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
