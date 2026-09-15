#!/bin/bash
# ============================================================
# qx-engine (Python) launcher — সারাক্ষণ চালু থাকবে
#  • finds python3 (sandbox venv → system)
#  • installs requirements once (best-effort)
#  • infinite restart loop: engine কখনো মরলে 2s পরে ফিরে আসে
#  • duplicate-guard inside main.py (port busy + healthy → exit)
# ============================================================
cd "$(dirname "$0")"

PY=""
for c in /home/z/.venv/bin/python3 /opt/qxvenv/bin/python3 python3 python3.12 /usr/local/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "[run.sh] ❌ python3 not found"
  exit 1
fi

# deps (quiet, best-effort — sandbox/Docker images may pre-install them)
if ! "$PY" -c "import websockets, socketio, aiohttp" >/dev/null 2>&1; then
  "$PY" -m pip install --quiet websockets "python-socketio[aiohttp]" >/dev/null 2>&1 || \
  "$PY" -m pip install --quiet --break-system-packages websockets "python-socketio[aiohttp]" >/dev/null 2>&1 || true
fi

while true; do
  "$PY" main.py
  code=$?
  # main.py exits 0 on duplicate-guard → don't loop
  [ "$code" -eq 0 ] && exit 0
  echo "[run.sh] engine exited ($code) — restarting in 2s"
  sleep 2
done
