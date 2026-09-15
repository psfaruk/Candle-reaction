"""Quotex (qxbroker) WebSocket client — Python port of the verified TS client.

প্রোটোকল: raw socket.io (engine.io EIO=3) over WS @ wss://ws2.qxbroker.com
ফ্লো:
  WS open → ← 0{sid} → → 40 → ← 40 → (1.2s pacing) →
  42["authorization",{"session":token,"isDemo":n,"tournamentId":0,"isFastHistory":true}]
    ├─ ← 42["s_authorization"] → paced subscriptions:
    │     instruments/update + chart_notification/get + depth/follow + history/load
    └─ ← 42["authorization/reject"] → isDemo অটো-ফ্লিপ (1→0) → উভয়ই reject হলে
        টোকেন মেয়াদোত্তীর্ণ রায় (আর হ্যামার নয়)

ডেটা ফরম্যাট:
  টিক: 42[["EURUSD_otc",1698238932,1.08432,1], ...] অথবা binary "quotes/stream"
  ক্যান্ডেল হিস্ট্রি: 451-["history/list/v2",{_placeholder}] + binary {asset,period,history:{candles}}
  লাইভ ক্যান্ডেল: 42["candle-generated",{asset,period,open,high,low,close,time}]
  ব্যালেন্স: 42["balance",{liveBalance,demoBalance}]
"""

import asyncio
import json
import re
import time

import websockets

WS_URL = "wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


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
    """Single-connection client with auto isDemo flip + reconnect."""

    def __init__(self, token: str, ev: QuotexEvents, pairs=None):
        self.auth = parse_qx_token(token)
        self.ev = ev
        self.closed = False
        self.auth_state = "idle"          # idle | pending | ok | rejected
        self.got_ticks = False
        self.ever_opened = False
        self.attempts = 0
        self._ws = None
        self._task = None
        self._demo_tried = {1: False, 0: False}
        self.set_pairs(pairs or [])

    # ---------------- public API ----------------

    def set_pairs(self, pairs):
        self.pairs = []
        self.pair_by_symbol = {}
        for p in pairs:
            base = re.sub(r"_otc$", "", p, flags=re.I).upper()
            q = f"{base}_otc"
            self.pairs.append({"base": base, "qAsset": q})
            self.pair_by_symbol[q] = base
            self.pair_by_symbol.setdefault(base, base)

    @property
    def connected(self) -> bool:
        return _ws_open(self._ws)

    @property
    def receiving_ticks(self) -> bool:
        return self.got_ticks

    async def start(self):
        self.closed = False
        self._task = asyncio.create_task(self._run())

    async def close(self):
        self.closed = True
        if self._ws is not None:
            try:
                await self._ws.close()
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
                delay = min(30, 3 * self.attempts)
                self._log(f"{delay}s পরে পুনঃসংযোগ…")
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            pass

    async def _session(self):
        is_demo = self.auth[1]
        headers = {
            "User-Agent": UA,
            "Origin": "https://qxbroker.com",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }
        if self.auth[0]:
            headers["Cookie"] = f"q9securid={self.auth[0]};"
        self._log(f"Quotex WS সংযোগ (ws2.qxbroker.com, isDemo={is_demo})… চেষ্টা {self.attempts + 1}")
        async with websockets.connect(
                WS_URL, additional_headers=headers, max_size=20 * 1024 * 1024,
                open_timeout=12, close_timeout=3, ping_interval=20, ping_timeout=20) as ws:
            self._ws = ws
            self.ever_opened = True
            self.attempts = 0
            self.auth_state = "idle"
            self._pending_binary_event = None
            self._instruments_seen = False
            self._auth_sent = False
            self.ev.on_raw("→ [WS OPEN]")
            ws_open = True
            first_fail_at = 0

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
                self._ws = None

    # ---------------- protocol ----------------

    def _send(self, raw: str):
        ws = self._ws
        if not _ws_open(ws):
            return
        self.ev.on_raw(f"→ {raw[:160]}")

        async def _do():
            try:
                await ws.send(raw)
            except Exception:
                pass
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_do())
        except RuntimeError:
            pass

    def _log(self, m):
        self.ev.on_log(m)

    def _handle_text(self, msg: str):
        if len(msg) < 2:
            return
        if len(msg) < 300:
            self.ev.on_raw(f"← {msg[:160]}")

        if msg.startswith("0{"):
            self._send("40")
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
                self._send("42" + json.dumps(["authorization", {
                    "session": self.auth[0],
                    "isDemo": self.auth[1],
                    "tournamentId": 0,
                    "isFastHistory": True,
                }], separators=(",", ":")))
            asyncio.get_running_loop().create_task(paced_auth())
            return
        if msg == "2" or msg == "2probe":
            self._send("3" if msg == "2" else "3probe")
            return
        if msg.startswith("3") or msg.startswith("41"):
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
        if evt in ("history/list/v2", "history/load", "success-instruments-candles",
                   "instruments-candles", "chart_notification/get"):
            self._handle_history_payload(data)
            return

    async def _flip_retry(self):
        """isDemo flip → নতুন সকেটে আবার auth।"""
        try:
            if self._ws is not None:
                await self._ws.close()
        except Exception:
            pass

    async def _safe_close(self):
        try:
            if self._ws is not None:
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
        hist = data.get("history", data.get("candles", data.get("data")))
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
            if isinstance(rc, list):
                try:
                    t = float(rc[0])
                    o = float(rc[1])
                    if len(rc) >= 5:
                        c = float(rc[2])
                        h = float(rc[3])
                        l = float(rc[4])
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
            if t is None or not math.isfinite(t):
                continue
            t_ms = t if t > 1e12 else t * 1000
            if None in (o, h, l, c):
                if o is not None and c is not None:
                    h, l = max(o, c), min(o, c)
                else:
                    continue
            candles.append({
                "t": t_ms, "o": o, "h": max(h, o, c), "l": min(l, o, c), "c": c,
            })
        if candles and pair:
            candles.sort(key=lambda x: x["t"])
            self.ev.on_candles(pair, candles)

    # ---------------- subscription ----------------

    async def _paced_subscribe(self):
        """সাবস্ক্রিপশন মেসেজগুলো পেসড (120ms) — একসাথে পাঠালে সার্ভার কানেকশন কাটে।"""
        if self.closed or self.auth_state != "ok":
            return
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
            if self.closed or not _ws_open(self._ws):
                return
            self._send(s)
            await asyncio.sleep(0.12)

    def _emit_tick(self, pair, price, t_ms):
        self.got_ticks = True
        self.ev.on_tick(pair, price, t_ms)
