"""Quotex (qxbroker) WebSocket client — curl_cffi Chrome-ছদ্মবেশ ট্রান্সপোর্ট।

=== Cloudflare bypass (ইউজারের প্রধান সমস্যার সমাধান) ===
Quotex তাদের WS এন্ডপয়েন্টে Cloudflare ব্যবহার করে। ডেটাসেন্টার IP
(Railway/AWS/…) + Python-এর ডিফল্ট TLS ফিঙ্গারপ্রিন্ট মিললে CF সংযোগই প্রত্যাখ্যান
করে ("Refused WebSocket upgrade: 403") — ব্রাউজার হেডার পাঠালেও।

সমাধান: curl_cffi আসল Chrome-এর TLS (JA3/JA4) + HTTP/2 ফিঙ্গারপ্রিন্ট হুবহু
নকল করে — CF-এর চোখে সংযোগটা একটা আসল ব্রাউজার। প্রোডাকশনে প্রমাণিত:
ws2.qxbroker.com এ handshake → authorization → টিক প্রবাহ পর্যন্ত সব কাজ করে।

ফিঙ্গারপ্রিন্ট রোটেশন: একটা ছদ্মবেশ ব্লক খেলে পরের চেষ্টায় অন্যটা
(chrome → chrome124 → safari → firefox)। ঐচ্ছিক QX_PROXY env দিলে
সংযোগটা প্রক্সির পেছন দিয়েও যেতে পারে (IP-লেভেল ব্লকের শেষ অস্ত্র)।

=== প্রোটোকল (আগের যাচাইকৃত লজিক, অপরিবর্তিত) ===
raw socket.io (engine.io EIO=3) over WS:
  WS open → ← 0{sid} → → 40 → ← 40 → (1.2s pacing) →
  42["authorization",{"session":token,"isDemo":n,"tournamentId":0,"isFastHistory":true}]
    ├─ ← 42["s_authorization"] → paced subscriptions (120ms):
    │     instruments/update + chart_notification/get + depth/follow + history/load
    └─ ← 42["authorization/reject"] → isDemo অটো-ফ্লিপ (১→০) → উভয়ই reject হলে
        টোকেন মেয়াদোত্তীর্ণ রায়

হার্টবিট: প্রতি 10s-এ → '2' (EIO4-স্টাইল ক্লায়েন্ট পিং), সার্ভার ← '3' পঙ্গ
দেয় (প্রমাণিত); 40s পঙ্গ না এলে সকেট মৃত → পুনঃসংযোগ।

ডেটা: টিক 42[["EURUSD_otc",ts,price,dir],…] / binary quotes/stream,
ক্যান্ডেল history/load, ব্যালেন্স 42["balance",{liveBalance,demoBalance}]।
"""

import asyncio
import json
import os
import re
import socket
import threading
import time

import websockets

# ============ HARDCODED — টোকেন দিলেই সাথে সাথে কানেক্ট (ইউজারের নির্দেশ) ============
WS_URL = "wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
BROWSER_HEADERS = {
    "Origin": "https://qxbroker.com",
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}
# Cloudflare ব্লক করলে ঘুরিয়ে আবার — একটা না মিললে আরেকটা মিলবেই
IMPERSONATE_ROTATION = ["chrome", "chrome124", "safari", "firefox"]
# ঐচ্ছিক: IP-লেভেল ব্লকের বিরুদ্ধে শেষ অস্ত্র — QX_PROXY=http://user:pass@host:port
QX_PROXY = (os.environ.get("QX_PROXY") or "").strip() or None

try:
    from curl_cffi.requests import WebSocket as CurlWebSocket
    from curl_cffi.const import CurlInfo
    HAS_CURL_CFFI = True
except Exception:  # curl_cffi নেই — websockets ফলব্যাকে চলবে
    HAS_CURL_CFFI = False

# curl WS ফ্রেম ফ্ল্যাগ (libcurl: TEXT=1 BINARY=2 CONT=4 CLOSE=8 PING=16 PONG=64)
_WS_BINARY = 2
_WS_CLOSE = 8


def _ws_open(ws) -> bool:
    """websockets>=14 new asyncio API uses .state; legacy used .closed."""
    if ws is None:
        return False
    try:
        from websockets.protocol import State
        return ws.state is State.OPEN
    except Exception:
        pass
    try:
        return not ws.closed
    except Exception:
        return False


def _fd_shutdown(ws):
    """সকেট fd shutdown — যেকোনো থ্রেড থেকে নিরাপদ (OS-লেভেল)।

    libcurl handle thread-safe নয়, কিন্তু fd shutdown পারে — ব্লকড
    recv-ওয়ালা থ্রেড তৎক্ষণাৎ ECONNRESET/CURL 56 এ ভেঙে পড়ে, তারপর
    recv-মালিক থ্রেড নিজেই terminate করে। (প্রোডাকশনে প্রমাণিত প্যাটার্ন।)"""
    try:
        fd = int(ws.curl.getinfo(CurlInfo.ACTIVESOCKET))
        if fd >= 0:
            s = socket.socket(fileno=fd)
            try:
                s.shutdown(socket.SHUT_RDWR)
            finally:
                s.detach()  # fd-র মালিকানা libcurl-কেই ফিরিয়ে দিই
    except Exception:
        pass


def parse_qx_token(raw: str):
    """ইউজার যা-ই পেস্ট করুক — সেশন টোকেন + isDemo বের করে দেয়।"""
    s = (raw or "").strip().strip('"\'')
    if not s:
        return "", 1
    # ফুল authorization ফ্রেম: 42["authorization",{"session":"...","isDemo":1,...}]
    if s.startswith("42"):
        try:
            arr = json.loads(s[2:])
            if (isinstance(arr, list) and arr and arr[0] == "authorization"
                    and isinstance(arr[1], dict) and arr[1].get("session")):
                return str(arr[1]["session"]), int(arr[1].get("isDemo", 1))
        except Exception:
            pass
    # JSON: {"session":"..."} / {"ssid":"..."}
    if s.startswith("{"):
        try:
            o = json.loads(s)
            for k in ("session", "ssid", "token"):
                if o.get(k):
                    return str(o[k]), int(o.get("isDemo", 1))
        except Exception:
            pass
    # কুকি-স্টাইল: ssid=XXX / q9securid=XXX (পুরো হেডারও হতে পারে)
    m = re.search(r'(?:q9securid|ssid|session|token)\s*=\s*"?([A-Za-z0-9_.~:-]+)', s, re.I)
    if m:
        s = m.group(1)
    # "123456:secret" ফরম্যাট → কোলনের আগে পূর্ণ সংখ্যা থাকলে সেটাই ssid
    if ":" in s:
        head = s.split(":")[0]
        if head.isdigit():
            s = head
    return s, 1


class QuotexEvents:
    def on_tick(self, pair, price, t):  # t = ms epoch
        pass

    def on_candles(self, pair, candles):
        pass

    def on_balance(self, balance, currency):
        pass

    def on_status(self, connected: bool, reason: str):
        pass

    def on_raw(self, line: str):
        pass

    def on_log(self, msg: str):
        pass


class QuotexClient:
    """Single-connection client with auto isDemo flip + reconnect.

    ট্রান্সপোর্ট: curl_cffi (Chrome ছদ্মবেশ — Cloudflare-proof) প্রাথমিক,
    plain websockets শেষ-আশ্রয় ফলব্যাক। উভয়েই একই প্রোটোকল হ্যান্ডলার চালায়।

    curl_cffi ট্রান্সপোর্ট থ্রেড-ভিত্তিক (curl-এর sync API):
      • dedicated OS thread: connect → recv loop → ফ্রেমগুলো event loop-এ
        call_soon_threadsafe দিয়ে পাঠায় (হ্যান্ডলার সব async প্রান্তেই চলে)
      • heartbeat thread: প্রতি 10s-এ '2' + 40s পঙ্গ-টাইমআউট পাহারা
      • সব সেন্ড threading.Lock-কৃত _t_send দিয়ে (যেকোনো থ্রেড থেকে নিরাপদ)
    """

    def __init__(self, token: str, ev: QuotexEvents, pairs=None, is_demo: int = None):
        self.auth = parse_qx_token(token)
        # অ্যাকাউন্ট-টাইপ সেটিং (ডেমো/রিয়েল) — Quotex-এর দুই ফিডের দাম আলাদা
        # হতে পারে; ইউজার যেটা দেখছে সেটাই বাছাই করবে। ডিফল্ট আগের মতো ডেমো।
        if is_demo in (0, 1):
            self.auth = (self.auth[0], int(is_demo))
        self.ev = ev
        self.closed = False
        self.auth_state = "idle"          # idle | pending | ok | rejected
        self.got_ticks = False
        self.ever_opened = False
        self.attempts = 0
        self.cf_blocks = 0                # Cloudflare ব্লক করবার সংখ্যা
        self._imp_idx = 0
        # --- websockets ফলব্যাক স্টেট ---
        self._ws = None
        self._send_lock = asyncio.Lock()
        # --- curl_cffi ট্রান্সপোর্ট স্টেট ---
        self._cws = None                  # curl_cffi WebSocket (connect সফল হলেই সেট)
        self._send_lock_t = None          # threading.Lock
        self._hard_stop = False
        self._session_ended = None        # asyncio.Event
        self._thread = None
        self._loop = None
        # --- সাধারণ ---
        self._task = None
        self._demo_tried = {1: False, 0: False}
        self._last_pong = time.time()
        self._last_tick_ts = time.time()
        self.set_pairs(pairs or [])

    # ---------------- public API ----------------

    def set_pairs(self, pairs):
        self.pairs = []
        self.pair_by_symbol = {}
        for p in pairs:
            base = re.sub(r"_otc$", "", p, flags=re.I).upper()
            q = f"{base}_otc"
            self.pairs.append({"base": base, "qAsset": q})
            # প্রতিটি কেস-ফর্মে key রাখি — লুকআপ যেভাবেই আসুক (wire-এ
            # "EURUSD_otc", হ্যান্ডলারে sym.upper() → "EURUSD_OTC") মিলবে।
            self.pair_by_symbol[q] = base        # EURUSD_otc (wire form)
            self.pair_by_symbol[q.upper()] = base  # EURUSD_OTC (upper lookups)
            self.pair_by_symbol.setdefault(base, base)  # EURUSD

    @property
    def connected(self) -> bool:
        if self._cws is not None:
            try:
                return not self._cws.closed
            except Exception:
                return False
        return _ws_open(self._ws)

    @property
    def receiving_ticks(self) -> bool:
        return self.got_ticks

    async def start(self):
        self.closed = False
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._run())

    async def close(self):
        self.closed = True
        await self._kill_transport()
        # থ্রেডকে সেশন-শেষ জানানোর সুযোগ (bounded — কখনো আটকে থাকবে না)
        if self._session_ended is not None and not self._session_ended.is_set():
            try:
                await asyncio.wait_for(self._session_ended.wait(), timeout=3)
            except Exception:
                pass
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    # ---------------- connection loop ----------------

    async def _run(self):
        try:
            while not self.closed and self.auth_state != "rejected":
                try:
                    await self._session()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self._log(f"Quotex সেশন ত্রুটি: {type(e).__name__}: {e}")
                if self.closed or self.auth_state == "rejected":
                    break
                self.attempts += 1
                # বারবার ব্যর্থ হলে ছদ্মবেশ বদলাই — CF একটা ফিঙ্গারপ্রিন্ট
                # ধরে ফেললেও পরেরটা দিয়ে ঢুকে যাব
                if self.attempts % 2 == 0:
                    self._imp_idx += 1
                delay = min(30, 3 * self.attempts)
                self._log(f"{delay}s পরে পুনঃসংযোগ…")
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            pass

    async def _session(self):
        is_demo = self.auth[1]
        # সেশন-স্টেট রিসেট (আগের _session-এর শুরুর মতোই)
        self.auth_state = "idle"
        self._pending_binary_event = None
        self._instruments_seen = False
        self._auth_sent = False
        self._last_pong = time.time()
        # ⚠ ever_opened রিসেট করি না — একবার খুললে latch (পুরনো আচরণ)।
        # isDemo-flip-এর পুনঃসংযোগ-বিরতিতে False হলে start_live ভুল করে
        # "নেটওয়ার্ক ব্লক" রায় দিতো (৫s নিয়ম) — অথচ সংযোগ ঠিকই চলছিল।
        if HAS_CURL_CFFI:
            await self._session_curl(is_demo)
        else:
            await self._session_ws(is_demo)

    # ---------------- ট্রান্সপোর্ট ১: curl_cffi (প্রাথমিক) ----------------

    async def _session_curl(self, is_demo):
        imp = IMPERSONATE_ROTATION[self._imp_idx % len(IMPERSONATE_ROTATION)]
        mode = " (প্রক্সি)" if QX_PROXY else ""
        self._log(f"Quotex WS সংযোগ (Chrome-ছদ্মবেশ: {imp}{mode}, isDemo={is_demo})… "
                  f"চেষ্টা {self.attempts + 1}")
        self._hard_stop = False
        self._cws = None
        self._send_lock_t = threading.Lock()
        ev_end = asyncio.Event()          # এই সেশনের নিজস্ব — পুরনো থ্রেডের
        self._session_ended = ev_end       # দেরিতে আসা কলব্যাক নতুনটা ভাঙবে না
        self._thread = threading.Thread(
            target=self._curl_thread, args=(imp, ev_end), daemon=True, name="qx-ws")
        self._thread.start()
        await ev_end.wait()

    def _curl_thread(self, imp: str, ev_end):
        """Dedicated OS thread: connect → recv loop। সব কলব্যাক event loop-এ।"""
        loop = self._loop
        ws = None
        try:
            ws = CurlWebSocket(autoclose=False)
            kw = {"impersonate": imp, "headers": BROWSER_HEADERS, "timeout": 15}
            if QX_PROXY:
                kw["proxy"] = QX_PROXY
            ws.connect(WS_URL, **kw)
        except Exception as e:
            cf = self._looks_like_cf_block(e)
            if loop is not None and not loop.is_closed():
                loop.call_soon_threadsafe(self._report_conn_fail, e, imp, cf)
                loop.call_soon_threadsafe(self._end_session,
                                          f"connect-fail: {type(e).__name__}", ev_end)
            return
        # সংযোগ সফল — স্টেট সেট করে event loop-এ জানাই
        self._cws = ws
        self.ever_opened = True
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._on_curl_open)
        hb_stop = threading.Event()
        hb = threading.Thread(target=self._curl_hb_thread, args=(ws, hb_stop),
                              daemon=True, name="qx-hb")
        hb.start()
        reason = "unknown"
        try:
            while not self._hard_stop and not self.closed:
                try:
                    data, flags = ws.recv()
                except Exception as e:
                    reason = f"recv-end: {type(e).__name__}"
                    break
                if flags & _WS_CLOSE:
                    reason = "server-close"
                    break
                if not data:
                    continue
                try:
                    text = data.decode("utf-8", "replace")
                except Exception:
                    continue
                is_bin = bool(flags & _WS_BINARY)
                try:
                    if loop is not None and not loop.is_closed():
                        loop.call_soon_threadsafe(self._dispatch_frame, text, is_bin)
                except RuntimeError:
                    break  # loop বন্ধ — আর নয়
        finally:
            hb_stop.set()
            # terminate শুধু এই (recv-মালিক) থ্রেডই করবে — আর কেউ যেন ঠিক
            # তখন সেন্ড করছে না থাকে, তাই সেন্ড-লকের আড়ালে (thread-safe)
            lock = self._send_lock_t
            if lock is not None:
                with lock:
                    try:
                        ws.terminate()
                    except Exception:
                        pass
            else:
                try:
                    ws.terminate()
                except Exception:
                    pass
            if self._cws is ws:
                self._cws = None
            if loop is not None and not loop.is_closed():
                try:
                    loop.call_soon_threadsafe(self._end_session, reason, ev_end)
                except RuntimeError:
                    pass

    def _curl_hb_thread(self, ws, stop_ev):
        """প্রতি 10s-এ '2' পিং (EIO4-স্টাইল) — Quotex সার্ভার নীরব
        ক্লায়েন্টকে ~30s পরে কেটে দেয়, আর পঙ্গ '3' দিয়ে উত্তর দেয় (প্রমাণিত)।
        40s পর্যন্ত পঙ্গ না এলে সকেট মৃত → fd-shutdown (থ্রেড-নিরাপদ) →
        recv-মালিক থ্রেড নিজেই পরিষ্কার করবে।"""
        while not stop_ev.wait(10):
            if self.closed or self._hard_stop:
                return
            try:
                with self._send_lock_t:
                    ws.send_str("2")
            except Exception:
                return
            if time.time() - self._last_pong > 40:
                self._log_ts("হার্টবিট টাইমআউট (কোনো পঙ্গ নেই) — পুনঃসংযোগ হচ্ছে")
                _fd_shutdown(ws)
                return

    def _log_ts(self, msg):
        """থ্রেড থেকে লগ — event loop-এ নিরাপদে।"""
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._log, msg)
            except RuntimeError:
                pass

    def _on_curl_open(self):
        """(event loop) WS খোলা সফল।"""
        self.attempts = 0
        self.ev.on_raw("→ [WS OPEN — Chrome ছদ্মবেশ সক্রিয়]")

    def _report_conn_fail(self, e, imp: str, cf: bool):
        """(event loop) সংযোগ ব্যর্থ — CF হলে বাংলায় স্পষ্ট রায় + রোটেশন।"""
        if cf:
            self.cf_blocks += 1
            self._imp_idx += 1
            nxt = IMPERSONATE_ROTATION[self._imp_idx % len(IMPERSONATE_ROTATION)]
            self._log(f"Cloudflare সংযোগ প্রত্যাখ্যান করেছে ({imp}) — পরের চেষ্টায় "
                      f"{nxt} ফিঙ্গারপ্রিন্টে হবে")
        else:
            self._log(f"Quotex সংযোগ ব্যর্থ: {type(e).__name__}: {str(e)[:120]}")
        self.ev.on_raw(f"✗ connect ({imp}): {type(e).__name__}: {str(e)[:120]}")

    @staticmethod
    def _looks_like_cf_block(e) -> bool:
        """CF/WAF-জাতীয় প্রত্যাখ্যান চিনি (403/challenge)।"""
        s = f"{type(e).__name__} {e}".lower()
        return ("403" in s or "forbidden" in s or "cloudflare" in s
                or "challenge" in s or "access denied" in s or "waf" in s)

    def _dispatch_frame(self, text: str, is_bin: bool):
        """(event loop) থ্রেড থেকে আসা ফ্রেম — হ্যান্ডলার এখানেই চলে।"""
        try:
            if is_bin:
                self._handle_binary(text)
            else:
                self._handle_text(text)
        except Exception as e:
            self.ev.on_raw(f"⚠ ফ্রেম হ্যান্ডলার: {type(e).__name__}: {e}")

    def _end_session(self, reason: str, ev_end=None):
        """(event loop) সেশন শেষ — শুধু নিজের সেশনের event-ই মুক্ত করে।"""
        if self.auth_state == "ok":
            self.ev.on_status(False, f"সংযোগ বিচ্ছিন্ন ({reason}) — পুনঃসংযোগ হচ্ছে")
        self.ev.on_raw(f"← [WS END {reason}]")
        ev = ev_end if ev_end is not None else self._session_ended
        if ev is not None:
            ev.set()

    # ---------------- ট্রান্সপোর্ট ২: websockets (ফলব্যাক) ----------------

    async def _session_ws(self, is_demo):
        """curl_cffi নেই এমন পরিবেশের জন্য আগের যাচাইকৃত async পথ।"""
        headers = dict(BROWSER_HEADERS)
        if self.auth[0]:
            headers["Cookie"] = f"q9securid={self.auth[0]};"
        self._log(f"Quotex WS সংযোগ (websockets ফলব্যাক, isDemo={is_demo})… "
                  f"চেষ্টা {self.attempts + 1}")
        async with websockets.connect(
                WS_URL, additional_headers=headers, max_size=20 * 1024 * 1024,
                open_timeout=12, close_timeout=3, ping_interval=20, ping_timeout=20) as ws:
            self._ws = ws
            self.ever_opened = True
            self.attempts = 0
            self.ev.on_raw("→ [WS OPEN]")
            ws_open = True
            hb_task = asyncio.create_task(self._heartbeat(ws))
            try:
                while not self.closed and ws_open:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=60.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed as e:
                        self.ev.on_raw(f"← [WS CLOSE {e.code}]")
                        if self.auth_state == "ok":
                            self.ev.on_status(False, f"সংযোগ বিচ্ছিন্ন ({e.code}) — পুনঃসংযোগ হচ্ছে")
                        ws_open = False
                        break
                    if isinstance(msg, bytes):
                        self._handle_binary(msg.decode("utf-8", "replace"))
                    else:
                        self._handle_text(msg)
            finally:
                hb_task.cancel()
                self._ws = None

    async def _heartbeat(self, ws):
        """(websockets ফলব্যাক) প্রতি 10s-এ '2'; 40s পঙ্গ না এলে পুনঃসংযোগ।"""
        while not self.closed:
            await asyncio.sleep(10)
            if self.closed or not _ws_open(ws):
                return
            try:
                async with self._send_lock:
                    await ws.send("2")
            except Exception:
                return
            if time.time() - self._last_pong > 40:
                self._log("Quotex হার্টবিট টাইমআউট (কোনো পঙ্গ নেই) — পুনঃসংযোগ হচ্ছে")
                try:
                    await ws.close(4000, "heartbeat timeout")
                except Exception:
                    pass
                return

    # ---------------- প্রোটোকল ----------------

    async def _send(self, raw: str):
        """সব সেন্ড এই এক পথ দিয়ে — awaited, serialized, নিরাপদ।
        curl ট্রান্সপোর্ট: executor-এ থ্রেড-লক সহ send_str।
        websockets ফলব্যাক: asyncio লক সহ সরাসরি।"""
        if self._cws is not None:
            self.ev.on_raw(f"→ {raw[:160]}")
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, self._t_send, raw)
            except Exception as e:
                self.ev.on_raw(f"✗ send failed: {raw[:60]} → {type(e).__name__}: {e}")
            return
        ws = self._ws
        if not _ws_open(ws):
            return
        self.ev.on_raw(f"→ {raw[:160]}")
        try:
            async with self._send_lock:
                await ws.send(raw)
        except Exception as e:
            self.ev.on_raw(f"✗ send failed: {raw[:60]} → {type(e).__name__}: {e}")

    def _t_send(self, raw: str):
        """(যেকোনো থ্রেড) curl WS সেন্ড — লকের ভেতরে।"""
        ws = self._cws
        lock = self._send_lock_t
        if ws is None or lock is None:
            return
        with lock:
            ws.send_str(raw)

    def _send_bg(self, raw: str):
        """সিঙ্ক কনটেক্সট থেকে ব্যাকগ্রাউন্ড সেন্ড।"""
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._send(raw))
        except RuntimeError:
            pass

    def _log(self, m):
        self.ev.on_log(m)

    def _handle_text(self, msg: str):
        # ⚠ এক-অক্ষরের engine.io ফ্রেম সবার আগে — নিচের len<2 ফিল্টার নয়তো
        # '3' (পঙ্গ) খেয়ে ফেলে, ফলে হার্টবিট ভুল টাইমআউট দেখায় আর সংযোগ কাটে।
        if msg.startswith("3"):
            self._last_pong = time.time()  # আমাদের '2' পিং-এর উত্তর এসেছে
            self.ev.on_raw("← 3 (pong)")
            return
        if msg == "2":
            self._send_bg("3")
            return
        if msg == "2probe":
            self._send_bg("3probe")
            return
        if len(msg) < 2:
            return
        if len(msg) < 300:
            self.ev.on_raw(f"← {msg[:160]}")

        if msg.startswith("0{"):
            self._send_bg("40")
            return
        if msg.startswith("40"):
            if self._auth_sent:
                return
            self._auth_sent = True
            self.auth_state = "pending"
            self._log("socket.io সংযোগ হয়েছে — অথেন্টিকেশন পাঠানো হচ্ছে…")

            async def paced_auth():
                # পেসিং গুরুত্বপূর্ণ: সাথে সাথে পাঠালে সার্ভার কানেকশন কেটে দেয়
                await asyncio.sleep(1.2)
                await self._send("42" + json.dumps(["authorization", {
                    "session": self.auth[0],
                    "isDemo": self.auth[1],
                    "tournamentId": 0,
                    "isFastHistory": True,
                }], separators=(",", ":")))
            asyncio.get_running_loop().create_task(paced_auth())
            return
        if msg.startswith("41"):
            return

        # binary প্রিফেস হেডার: 451-["event",{"_placeholder":true}] / 51-["event",…]
        m = re.match(r"^\d+-\[\s*\"([^\"]+)\"", msg)
        if m:
            self._pending_binary_event = m.group(1)
            self.ev.on_raw(f"← {msg[:140]}")
            return

        if msg.startswith("42"):
            try:
                arr = json.loads(msg[2:])
            except Exception:
                return
            if not isinstance(arr, list) or not arr:
                return
            head = arr[0]
            if isinstance(head, str):
                self._handle_event(head, arr[1] if len(arr) > 1 else None)
            elif isinstance(head, list):
                self._handle_quote_batch(arr)

    def _handle_binary(self, raw: str):
        # EIO=3: binary টেক্সট পেলোড '\x04' প্রিফিক্সসহ আসে
        body = raw[1:] if raw[:1] == "\x04" else raw
        try:
            payload = json.loads(body)
        except Exception:
            self.ev.on_raw(f"← [bin non-JSON {len(body)}b]")
            return
        evt = getattr(self, "_pending_binary_event", None)
        self._pending_binary_event = None
        if evt:
            self.ev.on_raw(f"← [bin:{evt}] {body[:140]}")
            self._handle_event(evt, payload)
            return
        # হেডারহীন binary — শেপ থেকে ইনফার করি
        if isinstance(payload, list) and payload and isinstance(payload[0], list):
            f = payload[0]
            if len(f) >= 3 and isinstance(f[0], str) and isinstance(f[2], (int, float)):
                self._handle_event("quotes/stream", payload)
                return
            if len(f) >= 2 and isinstance(f[0], (int, float)) and isinstance(f[1], str):
                self._handle_event("instruments/list", payload)
                return
        if isinstance(payload, dict):
            if payload.get("history") or payload.get("candles"):
                self._handle_event("history/list/v2", payload)
            elif payload.get("asset") and (payload.get("open") is not None or payload.get("close") is not None):
                self._handle_event("candle-generated", payload)
            elif payload.get("liveBalance") is not None or payload.get("demoBalance") is not None:
                self._handle_event("balance", payload)

    # ---------------- events ----------------

    def _handle_event(self, evt: str, data):
        if evt in ("s_authorization", "success-login"):
            if self.auth_state != "ok":
                self.auth_state = "ok"
                self._log("✅ Quotex অথেন্টিকেশন সফল — পেয়ার সাবস্ক্রিপশন চালু হচ্ছে…")
            self.ev.on_status(True, "authorized")
            asyncio.get_running_loop().create_task(self._paced_subscribe())
            return
        if evt == "authorization/reject":
            # isDemo অটো-ফ্লিপ: ১ → ০ (অ্যাকাউন্ট টাইপ আলাদা হতে পারে)
            if not self._demo_tried.get(self.auth[1], False):
                self._demo_tried[self.auth[1]] = True
                other = 0 if self.auth[1] == 1 else 1
                if not self._demo_tried.get(other, False):
                    self.auth = (self.auth[0], other)
                    self._log(f"টোকেন প্রত্যাখ্যাত (isDemo={1 if other == 0 else 0}) — অন্য অ্যাকাউন্ট টাইপে (isDemo={other}) চেষ্টা হচ্ছে…")
                    asyncio.get_running_loop().create_task(self._flip_retry())
                    return
            self.auth_state = "rejected"
            self.ev.on_status(False, "rejected")
            self._log("❌ টোকেন প্রত্যাখ্যাত (authorization/reject) — মেয়াদ শেষ/ভুল টোকেন, নতুন টোকেন দরকার")
            asyncio.get_running_loop().create_task(self._safe_close())
            return
        if evt in ("balance", "s_balance"):
            try:
                b = data.get("demoBalance", data.get("liveBalance", data.get("balance")))
                num = float(b)
                self.ev.on_balance(num, data.get("currency"))
            except (TypeError, ValueError, AttributeError):
                pass
            return
        if evt == "quotes/stream":
            if isinstance(data, list):
                self._handle_quote_batch(data)
            return
        if evt == "depth/change":
            if not self.got_ticks and isinstance(data, list) and data:
                sym = data[0][0] if isinstance(data[0], list) and data[0] else None
                if isinstance(sym, str):
                    p = self.pair_by_symbol.get(sym.upper())
                    if p:
                        self._log(f"[{sym}] মার্কেট স্ট্রিম জীবিত (depth) — সম্পূর্ণ টিকের অপেক্ষায়…")
            return
        if evt == "instruments/list":
            if not getattr(self, "_instruments_seen", False) and isinstance(data, list):
                self._instruments_seen = True
                matched = sum(1 for r in data if isinstance(r, list) and len(r) > 1
                              and isinstance(r[1], str) and r[1].upper() in self.pair_by_symbol)
                self._log(f"Quotex ইনস্ট্রুমেন্ট লিস্ট পাওয়া গেছে ({len(data)} অ্যাসেট, আমাদের পেয়ার {matched}টি মিলেছে)")
            return
        if evt in ("candle-generated", "depth"):
            # লাইভ (চলমান) ক্যান্ডেল আপডেট — close দামটা টিক হিসেবে ফিড করি
            try:
                sym = str(data.get("asset", "")).upper()
                p = self.pair_by_symbol.get(sym)
                close = float(data.get("close", data.get("c", 0)) or 0)
                t = float(data.get("time") or time.time())
                if p and close > 0:
                    t_ms = t if t > 1e12 else (t * 1000 if t > 1e9 else time.time() * 1000)
                    self._emit_tick(p, close, t_ms)
            except (TypeError, ValueError, AttributeError):
                pass
            return
        if evt == "history/list/v2":
            # ⭐ Quotex-এর আসল ১-মিনিট ক্যান্ডেল-হিস্ট্রি এখানেই আসে:
            #   {"asset": "EURUSD_otc", "period": 60,
            #    "history": [[ts, price, dir], …]   ← র-টিক (ক্যান্ডেল নয়)
            #    "candles": [[time, open, close, high, low, ticks, realTime], …] ← আসল ক্যান্ডেল (~২০০টি)}
            # প্রথম history/load-এ প্রতি পেয়ারে একবার এই বড় প্যাকেট আসে।
            # (.history-র টিকগুলো ক্যান্ডেল নয় — সেগুলো স্কিপ; .candles-ই ব্যবহার।)
            if isinstance(data, dict) and isinstance(data.get("candles"), list) and data["candles"]:
                self._handle_history_payload(data)
            return
        if evt in ("history/load", "success-instruments-candles",
                   "instruments-candles", "chart_notification/get"):
            # history/load ইভেন্ট (ছোট, ~১২ dict-ক্যান্ডেল) — ডিপ-হিস্ট্রি
            # পেজিং-এর রেসপন্সও এই ফরম্যাটেই আসে (time প্যারামিটার দিয়ে পেজ-ব্যাক)।
            self._handle_history_payload(data)
            return

    async def _flip_retry(self):
        """isDemo flip → নতুন সকেটে আবার auth।"""
        await self._kill_transport()

    async def _safe_close(self):
        await self._kill_transport()

    async def _kill_transport(self):
        """উভয় ট্রান্সপোর্ট বন্ধ — থ্রেড-নিরাপদ পথে।

        ⚠ libcurl handle thread-safe নয়: অন্য থ্রেডের ব্লকড recv-এর মাঝখানে
        terminate() ডাকলে প্রসেস SIGABRT-এ মারা যায় (প্রমাণিত)। তাই বাইরের
        থ্রেড থেকে আমরা কেবল (ক) WS close-ফ্রেম পাঠাই আর (খ) সকেট fd shutdown
        করি (OS-লেভেল, সর্বদা নিরাপদ) — recv-মালিক থ্রেড তৎক্ষণাৎ ভেঙে
        নিজেই (সেন্ড-লকের আড়ালে) terminate করে পরিষ্কার হয়।"""
        self._hard_stop = True
        ws = self._cws
        if ws is not None:
            # (ক) সার্ভারকে বিদায় জানাই — best-effort, লকের ভেতরে
            lock = self._send_lock_t
            if lock is not None:
                try:
                    with lock:
                        from curl_cffi.const import CurlWsFlag
                        ws.send(b"", CurlWsFlag.CLOSE)
                except Exception:
                    pass
            # (খ) সকেট বন্ধ — ব্লকড recv এখনই ভাঙবে
            _fd_shutdown(ws)
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass

    def _handle_quote_batch(self, rows):
        for q in rows:
            if not isinstance(q, list) or len(q) < 3:
                continue
            sym = q[0]
            if not isinstance(sym, str):
                continue
            p = self.pair_by_symbol.get(sym.upper())
            if not p:
                continue
            try:
                t = float(q[1])
                price = float(q[2])
            except (TypeError, ValueError):
                continue
            if price <= 0:
                continue
            t_ms = t if t > 1e12 else (t * 1000 if t > 1e9 else time.time() * 1000)
            self._emit_tick(p, price, t_ms)

    def _handle_history_payload(self, data):
        if not isinstance(data, dict):
            return
        asset_raw = str(data.get("asset") or data.get("symbol") or "").upper()
        pair = self.pair_by_symbol.get(asset_raw) if asset_raw else None

        raw_candles = None
        # ⭐ অগ্রাধিকার-ক্রম: "candles" (history/list/v2 — আসল ক্যান্ডেল) →
        # "data" (history/load — dict-ক্যান্ডেল) → "history" (শুধু সত্যিকারের
        # ক্যান্ডেল-সারি হলে; [ts, price, dir] র-টিক কখনোই নয়)
        if isinstance(data.get("candles"), list):
            raw_candles = data["candles"]
        elif isinstance(data.get("data"), list):
            raw_candles = data["data"]
        elif isinstance(data.get("history"), list):
            rows = data["history"]
            # ক্যান্ডেল-সারি = ≥৫ এলিমেন্ট; র-টিক = ৩ এলিমেন্ট → স্কিপ
            if rows and isinstance(rows[0], list) and len(rows[0]) >= 5:
                raw_candles = rows
        if raw_candles is None:
            # নেস্টেড শেপের ফলব্যাক (আগের হান্টার)
            hist = data.get("candles", data.get("history", data.get("data")))
            if isinstance(hist, list):
                raw_candles = hist
            elif isinstance(hist, dict):
                if isinstance(hist.get("candles"), list):
                    raw_candles = hist["candles"]
                elif isinstance(hist.get("data"), dict) and isinstance(hist["data"].get("candles"), list):
                    raw_candles = hist["data"]["candles"]
                else:
                    for v in hist.values():
                        if isinstance(v, dict) and isinstance(v.get("candles"), list):
                            raw_candles = v["candles"]
                            break
        if not raw_candles:
            return

        import math
        candles = []
        for rc in raw_candles:
            t = o = h = l = c = None
            tk = 0
            if isinstance(rc, list):
                try:
                    t = float(rc[0])
                    o = float(rc[1])
                    if len(rc) >= 5:
                        c = float(rc[2])
                        h = float(rc[3])
                        l = float(rc[4])
                        if len(rc) >= 6 and isinstance(rc[5], (int, float)):
                            tk = int(rc[5])       # Quotex নিজের টিক-কাউন্ট
                    elif len(rc) >= 3:
                        c = float(rc[2])
                        h, l = max(o, c), min(o, c)
                except (TypeError, ValueError):
                    continue
            elif isinstance(rc, dict):
                def _num(*keys):
                    for k in keys:
                        v = rc.get(k)
                        if isinstance(v, (int, float)):
                            return float(v)
                    return None
                t = _num("time", "t", "timestamp", "created_at")
                o = _num("open", "o")
                h = _num("high", "h")
                l = _num("low", "l")
                c = _num("close", "c")
                if isinstance(rc.get("ticks"), (int, float)):
                    tk = int(rc["ticks"])          # history/load dict-ফরম্যাটের টিক-কাউন্ট
            if t is None or not math.isfinite(t):
                continue
            if c is not None and (c <= 0 or c > 1e9):
                continue   # জাবার্ব গার্ড (dir=0/1-এর মতো ভুল পার্স)
            t_ms = int(t) if t > 1e12 else int(t * 1000)
            if None in (o, h, l, c):
                if o is not None and c is not None:
                    h, l = max(o, c), min(o, c)
                else:
                    continue
            candles.append({
                "t": t_ms, "o": o, "h": max(h, o, c), "l": min(l, o, c), "c": c,
                "tk": tk,
            })
        if candles and pair:
            candles.sort(key=lambda x: x["t"])
            self.ev.on_candles(pair, candles)

    # ---------------- subscription ----------------

    async def _paced_subscribe(self):
        """সাবস্ক্রিপশন + টিক-ওয়াচডগ। মেসেজগুলো পেসড (120ms) — একসাথে
        পাঠালে সার্ভার কানেকশন কাটে। এরপর 15s পরপর চেক: অথেন্টিকেটেড সকেট
        জীবিত কিন্তু 90s ধরে কোনো টিক না এলে সাবস্ক্রিপশন নীরবে হারিয়ে
        গিয়েছে ধরে ব্যাচটা আবার পাঠাই (সংযোগ ভাঙে না)।"""
        if self.closed or self.auth_state != "ok":
            return
        await self._send_subscription_batch()
        while not self.closed and self.auth_state == "ok" and (
                _ws_open(self._ws) or self._cws is not None):
            await asyncio.sleep(15)
            if self.closed or self.auth_state != "ok":
                return
            if not (_ws_open(self._ws) or self._cws is not None):
                return
            if time.time() - self._last_tick_ts > 90:
                self._log("90s ধরে কোনো টিক আসেনি — সাবস্ক্রিপশন আবার পাঠানো হচ্ছে…")
                self._last_tick_ts = time.time()
                await self._send_subscription_batch()

    async def _send_subscription_batch(self):
        sends = []
        for p in self.pairs:
            sends.append("42" + json.dumps(["instruments/update", {"asset": p["qAsset"], "period": 60}], separators=(",", ":")))
            sends.append("42" + json.dumps(["chart_notification/get", {"asset": p["qAsset"], "version": "1.0.0"}], separators=(",", ":")))
            sends.append("42" + json.dumps(["depth/follow", p["qAsset"]], separators=(",", ":")))
        for p in self.pairs:
            sends.append("42" + json.dumps(["history/load", {
                "asset": p["qAsset"], "index": 0, "time": int(time.time()),
                "offset": 720, "period": 60}], separators=(",", ":")))
        await asyncio.sleep(0.4)
        for i, s in enumerate(sends):
            if self.closed or not (_ws_open(self._ws) or self._cws is not None):
                return
            await self._send(s)
            await asyncio.sleep(0.12)

    async def request_history(self, base_symbol: str, end_time_s: int):
        """ডিপ-হিস্ট্রি পেজিং — `time` প্যারামিটার দিয়ে পেছনের ক্যান্ডেল।

        প্রতি রিকোয়েস্টে `time`-এর মিনিট থেকে ~১২টি ক্যান্ডেল আসে
        (history/load ইভেন্ট, dict-ফরম্যাট)। ইঞ্জিন এটা বারবার ডেকে
        পুরনো ক্যান্ডেল জমায়।"""
        p = self.pair_by_symbol.get(base_symbol.upper())
        qasset = f"{base_symbol.upper()}_otc" if p else base_symbol
        frame = "42" + json.dumps(["history/load", {
            "asset": qasset, "index": 0, "time": int(end_time_s),
            "offset": 720, "period": 60}], separators=(",", ":"))
        await self._send(frame)

    def _emit_tick(self, pair, price, t_ms):
        self.got_ticks = True
        self._last_tick_ts = time.time()
        t_i = int(t_ms)  # epoch-সেকেন্ড float হলে ×1000-ও float থাকে — int লাগবেই
        try:
            self.ev.on_tick(pair, price, t_i)
        except Exception as e:
            # হ্যান্ডলারের বাগ কখনোই WS সেশন ভাঙবে না
            self.ev.on_raw(f"⚠ on_tick handler: {type(e).__name__}: {e}")
