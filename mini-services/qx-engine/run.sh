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
# curl_cffi = Cloudflare bypass (Chrome TLS ছদ্মবেশ) — না থাকলে websockets
# ফলব্যাকে চলবে, তাই এটা আলাদা করে ইনস্টল করি যেন কখনো আটকে না বসে
if ! "$PY" -c "import websockets, socketio, aiohttp" >/dev/null 2>&1; then
  "$PY" -m pip install --quiet websockets "python-socketio[aiohttp]" >/dev/null 2>&1 || \
  "$PY" -m pip install --quiet --break-system-packages websockets "python-socketio[aiohttp]" >/dev/null 2>&1 || true
fi
if ! "$PY" -c "import curl_cffi" >/dev/null 2>&1; then
  echo "[run.sh] curl_cffi ইনস্টল হচ্ছে (Cloudflare bypass)…"
  "$PY" -m pip install --quiet curl_cffi >/dev/null 2>&1 || \
  "$PY" -m pip install --quiet --break-system-packages curl_cffi >/dev/null 2>&1 || \
  echo "[run.sh] ⚠ curl_cffi ইনস্টল হয়নি — websockets ফলব্যাকে চলবে"
fi

while true; do
  "$PY" main.py
  code=$?
  # 42 = ইচ্ছাকৃত বন্ধ (duplicate-guard / প্যারেন্ট মৃত) — রিস্টার্ট নয়।
  # সিগন্যাল/গ্রেসফুল শাটডাউন (0) বা ক্র্যাশ (≠0) — রিস্টার্ট করব।
  [ "$code" -eq 42 ] && exit 0
  echo "[run.sh] engine exited ($code) — restarting in 2s"
  sleep 2
done
