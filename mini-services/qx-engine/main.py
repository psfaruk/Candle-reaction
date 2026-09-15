#!/usr/bin/env python3
"""qx-engine — Python Quotex signal engine (production single-port server).

Architecture:
  browser → engine:$PORT
    /engine/*    → socket.io (realtime market data + RPC)
    /qx-health   → liveness/readiness probe (JSON)
    everything else → proxied to the Next.js server (QX_NEXT_PORT)

Quotex data comes from ws2.qxbroker.com with the user's session token
(Python implementation, as requested); without a token the app runs on
Yahoo real-market 1-minute candles (NOT simulation — real market data).
"""

import asyncio
import json
import os
import signal as _signal
import sys

import aiohttp
from aiohttp import web
import socketio

PORT = int(os.environ.get("QX_ENGINE_PORT") or os.environ.get("PORT") or 3003)
NEXT_PORT = int(os.environ.get("QX_NEXT_PORT") or 3000)


def _default_db_url() -> str:
    """Smart default DB location — works with or without env vars.

    Priority: DATABASE_URL env → /data (Railway volume) → legacy sandbox
    path → db/qx.db next to the engine. (db.py creates parent dirs.)
    """
    env = os.environ.get("DATABASE_URL")
    if env and not env.startswith("file:"):
        return env  # e.g. a real external DB URL — use as-is
    env_file = env[5:] if env and env.startswith("file:") else None
    if env_file and os.path.dirname(env_file):
        if os.path.isdir(os.path.dirname(env_file)) or os.access(os.path.dirname(env_file) or ".", os.W_OK):
            return env
    for d in ("/data",):
        if os.path.isdir(d) and os.access(d, os.W_OK):
            return f"file:{d}/qx.db"
    legacy = "/home/z/my-project/db"
    if os.path.isdir(legacy) and os.access(legacy, os.W_OK):
        return f"file:{legacy}/custom.db"
    here = os.path.dirname(os.path.abspath(__file__))
    return f"file:{here}/db/qx.db"


DB_URL = _default_db_url()

HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailers", "transfer-encoding", "upgrade", "host"}

sio = socketio.AsyncServer(async_mode="aiohttp", cors_allowed_origins="*",
                           ping_interval=25, ping_timeout=60,
                           max_http_buffer_size=5_000_000)

app = web.Application()
sio.attach(app, socketio_path="engine")

engine = None
http_session = None
main_loop = None


# ============================================================
# boot helpers — ইঞ্জিন অমর: duplicate guard, port retry
# ============================================================

async def _probe_existing() -> bool:
    """If a healthy engine already listens on our port — exit (no duplicates)."""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"http://127.0.0.1:{PORT}/qx-health",
                             timeout=aiohttp.ClientTimeout(total=3)) as r:
                if r.status == 200:
                    data = await r.json(content_type=None)
                    if data and data.get("ok"):
                        return True
    except Exception:
        pass
    return False


def emit_fn(event, data):
    """Engine → all browser sockets (thread-safe scheduling)."""
    if main_loop is None or main_loop.is_closed():
        return

    async def _do():
        try:
            await sio.emit(event, data)
        except Exception:
            pass
    try:
        asyncio.run_coroutine_threadsafe(_do(), main_loop)
    except RuntimeError:
        pass


# ============================================================
# socket.io RPC handlers — same event contract as before
# ============================================================

@sio.on("connect")
async def on_connect(sid, environ):
    if engine is not None:
        engine.socket_clients += 1
        await sio.emit("hello", {
            "status": engine.status_snapshot(),
            "settings": engine.get_settings(),
            "logs": engine.get_logs(),
        }, to=sid)


@sio.on("disconnect")
async def on_disconnect(sid):
    if engine is not None:
        engine.socket_clients = max(0, engine.socket_clients - 1)


@sio.on("get-market")
async def on_get_market(sid, data=None):
    return engine.snapshot()


@sio.on("get-status")
async def on_get_status(sid, data=None):
    return engine.status_snapshot()


@sio.on("get-settings")
async def on_get_settings(sid, data=None):
    return engine.get_settings()


@sio.on("get-history")
async def on_get_history(sid, data=None):
    d = data or {}
    limit = min(int(d.get("limit") or 500), 1000)
    return {"candles": engine.get_history(d.get("pair") or "", limit)}


@sio.on("get-signals")
async def on_get_signals(sid, data=None):
    d = data or {}
    try:
        return {"signals": engine.get_signals({
            "pair": d.get("pair", "ALL"),
            "direction": d.get("direction", "ALL"),
            "periodH": d.get("periodH", 0),
            "source": d.get("source"),
            "limit": d.get("limit", 120),
        })}
    except Exception as e:
        return {"signals": [], "error": str(e)}


@sio.on("get-stats")
async def on_get_stats(sid, data=None):
    d = data or {}
    try:
        return engine.get_stats({"periodH": d.get("periodH", 0), "source": d.get("source")})
    except Exception as e:
        return {"overall": None, "perPair": [], "error": str(e)}


@sio.on("get-log")
async def on_get_log(sid, data=None):
    return {"logs": engine.get_logs(), "raw": engine.get_raw_log()}


@sio.on("save-settings")
async def on_save_settings(sid, data=None):
    try:
        return await engine.save_settings(data or {})
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@sio.on("connect-token")
async def on_connect_token(sid, data=None):
    d = data or {}
    token = (d.get("token") or "").strip()
    if len(token) < 10:
        return {"ok": False, "msg": "টোকেন খুব ছোট — সঠিক QX (ssid) টোকেন দিন"}
    # ঐচ্ছিক isDemo (0=রিয়েল, 1=ডেমো) — Quotex-এর দুই ফিডের দাম আলাদা,
    # ইউজার যেটা দেখছে সেটাই আসবে (না দিলে সেভ-করা accountMode)
    is_demo = d.get("isDemo")
    try:
        if is_demo is not None:
            is_demo = int(is_demo)
            if is_demo not in (0, 1):
                is_demo = None
    except (TypeError, ValueError):
        is_demo = None
    try:
        return await engine.start_live(token, is_demo=is_demo)
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@sio.on("disconnect-live")
async def on_disconnect_live(sid, data=None):
    await engine.stop_live()
    return {"ok": True, "msg": "Quotex লাইভ সংযোগ বন্ধ — রিয়েল মার্কেট ফিড চালু"}


@sio.on("run-backtest")
async def on_run_backtest(sid, data=None):
    try:
        summary = await engine.run_backtest()
        return {"ok": True, "summary": summary}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


@sio.on("get-backtest")
async def on_get_backtest(sid, data=None):
    try:
        return {"ok": True, "summary": engine.get_last_backtest()}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


# ============================================================
# HTTP: health + Next.js reverse proxy
# ============================================================

async def health(request):
    feed = engine.status_snapshot() if engine else {}
    return web.json_response({
        "ok": True,
        "service": "qx-engine-py",
        "mode": feed.get("mode"),
        "feedProvider": feed.get("feedProvider"),
        "pairs": len(engine.active_pairs) if engine else 0,
        "uptimeSec": feed.get("uptimeSec", 0),
    })


async def proxy_to_next(request: web.Request) -> web.StreamResponse:
    # NEVER proxy engine-prefixed paths back to Next — that would create an
    # inter-process loop (Next rewrites /engine/* back to this engine).
    if request.path == "/engine" or request.path.startswith("/engine/"):
        return web.json_response({"error": "engine route not found",
                                   "path": request.path}, status=404)
    if http_session is None:
        return web.Response(status=502, text="next-server unreachable (no session)")
    target = f"http://127.0.0.1:{NEXT_PORT}{request.rel_url}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}
    headers["Host"] = f"127.0.0.1:{NEXT_PORT}"
    body = await request.read()
    try:
        async with http_session.request(request.method, target, headers=headers,
                                        data=body, allow_redirects=False,
                                        auto_decompress=False) as resp:
            out = web.StreamResponse(status=resp.status, reason=resp.reason)
            for k, v in resp.headers.items():
                if k.lower() in HOP_HEADERS or k.lower() == "set-cookie":
                    if k.lower() != "set-cookie":
                        continue
                out.headers[k] = v
            if request.method == "HEAD" or resp.status in (204, 304):
                return out
            await out.prepare(request)
            async for chunk in resp.content.iter_any():
                await out.write(chunk)
            await out.write_eof()
            return out
    except Exception:
        return web.Response(status=502, text="next-server unreachable")


app.router.add_get("/qx-health", health)
app.router.add_route("*", "/{tail:.*}", proxy_to_next)


# ============================================================
# startup
# ============================================================

async def on_startup(app):
    global engine, http_session, main_loop
    main_loop = asyncio.get_running_loop()

    if await _probe_existing():
        print(f"[qx-engine] পোর্ট {PORT}-এ একটি সুস্থ ইঞ্জিন আগেই চলছে — ডুপ্লিকেট বন্ধ করা হলো")
        os._exit(42)  # 42 = ইচ্ছাকৃত বন্ধ (run.sh আর রিস্টার্ট করবে না)

    from qxengine.db import DB
    from qxengine.market_engine import MarketEngine
    db = DB(DB_URL)
    engine = MarketEngine(db)
    engine.set_emitter(emit_fn)

    http_session = aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=60, sock_connect=10, sock_read=60))

    # listen FIRST (health ready instantly); heavy work is backgrounded
    async def _start_engine():
        try:
            await engine.start()
        except Exception as e:
            print(f"[qx-engine] ⚠ engine.start ত্রুটি: {e}")
            await asyncio.sleep(3)
            try:
                await engine.start()
            except Exception as e2:
                print(f"[qx-engine] রিস্টার্টও ব্যর্থ: {e2}")
    asyncio.create_task(_start_engine())
    asyncio.create_task(_parent_watchdog())
    print(f"[qx-engine] ✅ Python engine listening on 0.0.0.0:{PORT} "
          f"(socket.io /engine, health /qx-health, next → :{NEXT_PORT})")


async def on_cleanup(app):
    if http_session is not None:
        await http_session.close()
    if engine is not None and engine.yahoo is not None:
        await engine.yahoo.stop()


async def _parent_watchdog():
    """If the process that spawned us (Next.js server) dies — exit cleanly,
    so a replacement Next process can spawn a fresh engine (no orphans)."""
    ppid_s = os.environ.get("QX_PARENT_PID", "").strip()
    if not ppid_s.isdigit():
        return
    ppid = int(ppid_s)
    if ppid <= 1:
        return
    while True:
        await asyncio.sleep(5)
        try:
            os.kill(ppid, 0)
        except ProcessLookupError:
            print(f"[qx-engine] 👋 প্যারেন্ট (pid {ppid}) বন্ধ — ইঞ্জিনও বন্ধ হচ্ছে")
            os._exit(42)  # 42 = ইচ্ছাকৃত বন্ধ (রিস্টার্ট নয়)
        except PermissionError:
            pass  # exists, owned by another user — still alive


app.on_startup.append(on_startup)
app.on_cleanup.append(on_cleanup)


def main():
    # EADDRINUSE → 2s পরে আবার বাইন্ড (সুপারভাইজারের আগে নিজেই সারার চেষ্টা)
    for attempt in range(1, 8):
        try:
            web.run_app(app, host="0.0.0.0", port=PORT, print=None,
                        shutdown_timeout=5, handle_signals=True)
            return
        except OSError as e:
            if e.errno == 98:  # EADDRINUSE
                print(f"[qx-engine] ⚠ পোর্ট {PORT} ব্যস্ত — 2s পরে আবার (চেষ্টা {attempt}/7)")
                import time as _t
                _t.sleep(2)
                continue
            raise
    print("[qx-engine] পোর্ট বাইন্ড বারবার ব্যর্থ — সুপারভাইজার রিস্টার্ট করবে")
    sys.exit(1)


if __name__ == "__main__":
    main()
