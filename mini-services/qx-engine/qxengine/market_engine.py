"""Market engine orchestrator — LIVE-ONLY (সিমুলেশন চিরতরে বাদ).

Feeds:
  • Quotex (primary): ws2.qxbroker.com সেশন টোকেন দিয়ে টিক-বাই-টিক + হিস্ট্রি
  • Yahoo real-market (fallback): টোকেন না থাকলে/মেয়াদ শেষ হলে একই পেয়ারের
    রিয়েল ইন্টারব্যাংক ১-মিনিট ক্যান্ডেল — অ্যাপ কখনো খালি থাকে না, কখনো fake নয়।

Pipeline (both feeds): candle close → pending signal resolution → new signal
evaluation (confluence model) → DB persist → socket.io broadcast.
"""

import asyncio
import json
import time

from .types import MINUTE, js_round, make_candle, make_signal
from .pairs import ALL_PAIRS, DEFAULT_PAIRS, get_pair_def
from .db import DB
from .candle_store import PairCandleStore
from .levels import detect_zones
from .signal_engine import evaluate_signal, preview_running_score
from .backtest import backtest_pair, aggregate_backtest
from .quotex_client import QuotexClient, QuotexEvents
from .yahoo_feed import YahooFeed

REJECTED_MSG = ("টোকেন প্রত্যাখ্যাত — মেয়াদ শেষ/ভুল টোকেন। qxbroker.com-এ লগইন করে "
                "F12 → Application → Cookies → ssid (বা Network → WS → authorization লাইন) "
                "থেকে নতুন করে কপি করে আবার পেস্ট করুন")
NETWORK_FAIL_MSG = "Quotex সার্ভারে পৌঁছানো যাচ্ছে না (নেটওয়ার্ক/আইপি ব্লক) — রিয়েল মার্কেট ফিড চলছে, পেছনে চেষ্টা চলবে"


class MarketEngine:
    def __init__(self, db: DB):
        self.db = db
        self.stores = {}
        self.pending = {}          # pair → awaiting resolution
        self.feed_owner = {}       # pair → 'quotex' | 'yahoo'
        self.active_pairs = list(DEFAULT_PAIRS)
        self.min_confidence = 70
        self.qx = None
        self.qx_token = None
        self.token_source = "db"
        self.socket_clients = 0
        self.last_live_tick_at = 0
        self.signals_generated = 0
        self.started_at = int(time.time() * 1000)
        self.logs = []
        self.raw_log = []
        self._emit_fn = None
        self._tasks = []
        self.last_minute = 0
        self._tick_dirty = set()     # pair-গুলো নতুন টিক পেয়েছে (১০Hz ফ্লাশ হবে)
        self.account = {"balance": None, "currency": None, "login": None}
        self.yahoo = YahooFeed(self._on_yahoo_bars, self.log)
        # Quotex-নির্দিষ্ট স্টেট
        self.account_mode = "demo"            # demo | real — Quotex ফিড-নির্বাচন
        self._qx_purged = set()               # যেসব পেয়ারের Yahoo-ডেটা মুছে Quotex বসানো হয়েছে
        self._page_empty = {}                 # pair → টানা খালি পেজ-সংখ্যা (হিস্ট্রি শেষ ধরার জন্য)
        self._page_wait = {}                   # pair → শেষ পেজ-রিকোয়েস্ট epoch-ms
        self._page_done = set()                # পেয়ারের ডিপ-হিস্ট্রি সম্পূর্ণ

    # ---------------- lifecycle ----------------

    def set_emitter(self, fn):
        self._emit_fn = fn

    def emit(self, event, data):
        if self._emit_fn is None:
            return
        try:
            self._emit_fn(event, data)
        except Exception:
            pass

    async def start(self):
        s = self.db.ensure_settings()
        self.min_confidence = s.get("minConfidence", 70) or 70
        pairs_csv = s.get("pairs") or ",".join(DEFAULT_PAIRS)
        self.active_pairs = [p for p in pairs_csv.split(",") if p] or list(DEFAULT_PAIRS)
        try:
            self.min_confidence = int(self.min_confidence)
        except (TypeError, ValueError):
            self.min_confidence = 70

        # সিমুলেশন চিরতরে বিদায় — legacy fake data মুছে রিয়েল ডেটা দিয়ে শুরু
        self.db.purge_simulation_data()

        env_token = ("" + (_getenv("QX_TOKEN") or "")).strip()
        self.token_source = "env" if env_token else "db"
        token = env_token or s.get("qxToken") or None
        # অ্যাকাউন্ট-টাইপ: demo | real (Quotex-এর দুই ফিডের দাম আলাদা —
        # ইউজার যেটা দেখছে সেটাই বাছাই)
        self.account_mode = "real" if str(s.get("accountMode") or "demo").lower() == "real" else "demo"
        self._qx_started_at = time.time()   # ফিড-রোল শিডিউলারের ঘড়ি

        self.log("info", f"ইঞ্জিন চালু (Python) — {len(self.active_pairs)}টি পেয়ার, রিয়েল-ডেটা-অনলি মোড")

        # প্রতিটি পেয়ার: DB থেকে লোড + দরকার হলে Yahoo রিয়েল হিস্ট্রি বুটস্ট্র্যাপ
        for sym in self.active_pairs:
            self.stores[sym] = PairCandleStore(sym)
        self._tasks.append(asyncio.create_task(self._bootstrap_all()))
        self.last_minute = int(time.time() * 1000) // MINUTE

        self._tasks.append(asyncio.create_task(self._minute_watcher()))
        self._tasks.append(asyncio.create_task(self._broadcast_loop()))
        self._tasks.append(asyncio.create_task(self._tick_broadcast_loop()))
        self._tasks.append(asyncio.create_task(self._yahoo_loop()))
        self._tasks.append(asyncio.create_task(self._deep_history_loop()))
        self._tasks.append(asyncio.create_task(self._canary_loop()))

        if token:
            self._tasks.append(asyncio.create_task(self._auto_connect(token)))
        else:
            self.log("info", "QX টোকেন নেই — Quotex সংযোগের জন্য Settings ট্যাবে টোকেন দিন "
                             "(এখন রিয়েল মার্কেট ফিড চলছে)")

    async def _bootstrap_all(self):
        """Load stores from DB; fetch fresh Yahoo real history when stale."""
        for sym in list(self.active_pairs):
            try:
                await self._bootstrap_pair(sym)
            except Exception as e:
                self.log("warn", f"[{sym}] বুটস্ট্র্যাপ ত্রুটি: {e}")
            await asyncio.sleep(0.3)

    async def _bootstrap_pair(self, sym):
        now_ms = int(time.time() * 1000)
        cur_minute = now_ms // MINUTE * MINUTE
        have = self.db.count_candles(sym)
        last_ts = self.db.last_candle_ts(sym) or 0
        stale = (now_ms - last_ts) > 2 * 3_600_000
        if have < 120 or stale:
            bars = await self.yahoo.fetch_once(sym)
            candles = [make_candle(sym, ts, o, h, l, c, source="LIVE")
                       for (ts, o, h, l, c) in bars if ts < cur_minute]
            if candles:
                self.db.insert_candles(candles)
                self.log("info", f"[{sym}] Yahoo রিয়েল মার্কেট হিস্ট্রি: {len(candles)}টি ১-মিনিট ক্যান্ডেল")
        candles = self.db.load_candles(sym, 1000)
        store = self.stores.get(sym)
        if store is None:
            store = self.stores[sym] = PairCandleStore(sym)
        # মার্জ-ফিক্স: bootstrap দেরিতে শেষ হলে লাইভ-টিকে ইতিমধ্যে বন্ধ
        # হয়ে যাওয়া ক্যান্ডেল রিপ্লেসমেন্টে হারাবে না (আগে হারাত — ১ মিনিট ফাঁক)
        if store.candles:
            have = {c["ts"] for c in candles}
            extra = [c for c in store.candles if c["ts"] not in have]
            if extra:
                candles = candles + extra
                candles.sort(key=lambda x: x["ts"])
                candles = candles[-store.max_keep:]
        store.candles = candles
        self.feed_owner.setdefault(sym, "yahoo")
        if candles and not store.running:
            store.start_running(cur_minute, candles[-1]["close"])
            self._tick_dirty.add(sym)   # বুটস্ট্র্যাপের রানিং ক্যান্ডেল সাথে সাথেই চার্টে

    async def _yahoo_loop(self):
        await asyncio.sleep(2)  # let bootstrap start filling
        await self.yahoo.start()
        while True:
            self.yahoo.active_pairs = [p for p in self.active_pairs if p in self.stores]
            self.yahoo.skip_pairs = {p for p, owner in self.feed_owner.items()
                                     if owner == "quotex" and self._qx_fresh(p)}
            await asyncio.sleep(5)

    # ---------------- Quotex ডিপ-হিস্ট্রি পেজিং ----------------

    DEEP_TARGET = 720      # প্রতি পেয়ারে লক্ষ্য-ক্যান্ডেল (~১২ ঘণ্টা)
    PAGE_PAUSE_MS = 1500   # পেয়ার প্রতি পেজ-রিকোয়েস্টের ব্যবধান

    async def _deep_history_loop(self):
        """history/load-এর `time` প্যারামিটার দিয়ে পেছনে পেছনে ক্যান্ডেল জমানো।

        প্রতি রিকোয়েস্টে `time`-এর মিনিট থেকে ~১২টি ক্যান্ডেল আসে; প্রথম
        সাবস্ক্রিপশনে history/list/v2 ~২০০টি দেয়। লক্ষ্য ৭২০ — চার্ট খুললেই
        Quotex-অ্যাপের মতো গভীর হিস্ট্রি, ব্যাকটেস্ট/সিগন্যালও সমৃদ্ধ।"""
        while True:
            try:
                await asyncio.sleep(2)
                qx = self.qx
                if (qx is None or not qx.connected or qx.auth_state != "ok"):
                    continue
                now_ms = int(time.time() * 1000)
                for sym in list(self.active_pairs):
                    if sym not in self._qx_purged or sym in self._page_done:
                        continue
                    store = self.stores.get(sym)
                    if store is None:
                        continue
                    if len(store.candles) >= self.DEEP_TARGET:
                        self._page_done.add(sym)
                        self.log("info", f"[{sym}] ডিপ-হিস্ট্রি সম্পূর্ণ ({len(store.candles)} ক্যান্ডেল)")
                        continue
                    if self._page_empty.get(sym, 0) >= 3:
                        self._page_done.add(sym)   # পেয়ারের সব হিস্ট্রি শেষ
                        continue
                    last = self._page_wait.get(sym, 0)
                    if now_ms - last < self.PAGE_PAUSE_MS:
                        continue
                    oldest = store.candles[0]["ts"] if store.candles else int(time.time() * 1000)
                    # এক পেজ আগের শেষে — ১২-মিনিট জানালা, মিনিট-সারিবদ্ধ
                    end_s = (oldest - 12 * 60_000) // 1000
                    self._page_wait[sym] = now_ms
                    try:
                        await qx.request_history(sym, end_s)
                    except Exception:
                        pass
                    await asyncio.sleep(0.35)   # পেয়ার-মধ্যবর্তী ব্রেথ
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log("warn", f"ডিপ-হিস্ট্রি লুপ ত্রুটি: {e}")

    # ---------------- Quotex ফিড-ক্যানারি (জেনারেশন-রোটেশন প্রতিরোধ) ----------------

    # ⭐ Quotex OTC ফিড পর্যায়ক্রমে রোটেট হয় — পুরনো সংযোগ পুরনো জেনারেশনে আটকে
    # থাকে, তখন অ্যাপের দাম ইউজারের Quotex-অ্যাপের সাথে মিলতে থাকে না (কয়েক পিপ
    # এড়ে যায়)। প্রমাণিত: ৭ পেয়ারে হুবহু মিল + ১ পেয়ারে ৩০ মিনিট ডাইভারজেন্স।
    # প্রতিরোধ: ① প্রতি ৩ মিনিটে একটি ফ্রেশ ক্যানারি-সংযোগ হিস্ট্রি আনে —
    # সাথে নিজের ক্যান্ডেল মেলায়; না মিললে মূল সংযোগ রোল হয় ② ২৫ মিনিট পরপর
    # প্রোঅ্যাক্টিভ রোল (রোটেশন ধরা না পড়লেও বাউন্ডেড)।
    CANARY_INTERVAL_S = 180
    CANARY_DUR_S = 14
    FEED_RECONNECT_S = 1500

    async def _canary_loop(self):
        while True:
            try:
                await asyncio.sleep(self.CANARY_INTERVAL_S)
                if not (self.qx_token and self._qx_fresh_any()):
                    continue
                if time.time() - self._qx_started_at > self.FEED_RECONNECT_S:
                    self.log("info", "Quotex ফিড ২৫ মিনিট পুরনো — OTC জেনারেশন-রোটেশনের "
                                    "বিরুদ্ধে প্রোঅ্যাক্টিভ রোল (নতুন সংযোগ = ইউজারের অ্যাপের মতো ফিড)")
                    await self._reconnect_live()
                    continue
                await self._canary_check()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log("warn", f"ক্যানারি লুপ ত্রুটি: {e}")

    async def _canary_check(self):
        """ফ্রেশ সংযোগ থেকে ক্যানোনিক্যাল হিস্ট্রি + লাইভ টিক এনে নিজের সাথে মেলাই।

        দুই স্তরের যাচাই:
        ① ক্যান্ডেল: ক্যানারি খোলার আগের টিক-নির্মিত বন্ধ-ক্যান্ডেলের স্ন্যাপশট বনাম
           ক্যানারির হিস্ট্রি (ক্রসটক-রেফাইন স্টোর বদলে দেয় বলে আগে স্ন্যাপ নিই)
        ② লাইভ টিক: চলমান দাম বনাম ক্যানারির শেষ লাইভ টিক — ক্রসটকের ওপর
           নির্ভরশীল নয়, তাই সবচেয়ে নির্ভরযোগ্য
        যেকোনোটা ডাইভার্ট করলে মূল সংযোগ রোল হয়।"""
        # ক্যানারির আগের স্ন্যাপশট (ইঞ্জিনের নিজের লাইভ-টিক থেকে বানানো ক্যান্ডেল)
        pre = {}
        for sym in self.active_pairs:
            st = self.stores.get(sym)
            if st is not None and st.candles:
                pre[sym] = {c["ts"]: c for c in st.candles[-3:]}
        ev = _CanaryEvents()
        c = QuotexClient(self.qx_token, ev, is_demo=0 if self.account_mode == "real" else 1)
        c.set_pairs(self.active_pairs)
        await c.start()
        await asyncio.sleep(self.CANARY_DUR_S)
        try:
            await c.close()
        except Exception:
            pass
        diverged = []
        checked = 0
        for sym in self.active_pairs:
            st = self.stores.get(sym)
            if st is None:
                continue
            pdef = get_pair_def(sym)
            pip = pdef["pip"]
            tol = pip * 2
            # ① ক্যান্ডেল-স্ন্যাপশট যাচাই
            bad = good = 0
            snap = pre.get(sym, {})
            for ts, can in ev.candles.get(sym, {}).items():
                mine = snap.get(ts)
                if mine is None:
                    continue
                checked += 1
                if (abs(mine["close"] - can["c"]) > tol
                        or abs(mine["open"] - can["o"]) > tol):
                    bad += 1
                else:
                    good += 1
            # ② লাইভ-টিক যাচাই — ক্রসটক-ইমিউন
            live_div = False
            can_last = ev.last_ticks.get(sym)
            if st.running is not None and can_last:
                if abs(st.running.last - can_last) > pip * 2.5:
                    live_div = True
            if live_div or (bad >= 2 and good == 0):
                diverged.append(sym)
        if checked == 0 and not any(ev.last_ticks.values()):
            return   # ক্যানারি ডেটা পায়নি — পরের বার আবার
        if diverged:
            self.log("warn", f"ফিড-ডাইভারজেন্স ({', '.join(diverged)}) — Quotex OTC জেনারেশন "
                            "রোটেট হয়েছে; নতুন সংযোগে রোল করা হচ্ছে যেন Quotex-অ্যাপের "
                            "সাথে ১০০% মিল থাকে")
            await self._reconnect_live()

    async def _reconnect_live(self):
        tok = self.qx_token
        if not tok:
            return
        await self._stop_live_client()
        self._qx_started_at = time.time()
        self._tasks.append(asyncio.create_task(self._auto_connect(tok)))

    def _qx_fresh(self, pair: str) -> bool:
        return (self.qx is not None and self.qx.connected and self.qx.auth_state == "ok"
                and int(time.time() * 1000) - self.last_live_tick_at < 15_000)

    # ---------------- Quotex live ----------------

    async def start_live(self, token: str, is_demo: int = None):
        await self._stop_live_client()
        self.qx_token = token
        try:
            self.db.update_setting(qxToken=token)
        except Exception:
            pass
        if is_demo not in (0, 1):
            is_demo = 0 if self.account_mode == "real" else 1
        else:
            # স্পষ্ট isDemo দিলে সেটিংসও সেটাই হোক (UI-তে দেখাবে)
            mode = "real" if is_demo == 0 else "demo"
            if mode != self.account_mode:
                self.account_mode = mode
                try:
                    self.db.update_setting(accountMode=mode)
                except Exception:
                    pass
        self.qx = QuotexClient(token, _EngineQuotexEvents(self), is_demo=is_demo)
        self.qx.set_pairs(self.active_pairs)
        self._qx_started_at = time.time()
        await self.qx.start()

        t0 = time.monotonic()
        while time.monotonic() - t0 < 15:
            await asyncio.sleep(0.25)
            if self.qx.receiving_ticks:
                return {"ok": True, "msg": "লাইভ Quotex টিক ডেটা চলছে"}
            if self.qx.auth_state == "rejected":
                await self._stop_live_client()
                self.log("warn", "Quotex টোকেন প্রত্যাখ্যাত — মেয়াদ শেষ হয়েছে, নতুন টোকেন দরকার")
                return {"ok": False, "msg": REJECTED_MSG}
            if not getattr(self.qx, "ever_opened", False) and time.monotonic() - t0 > 5:
                return {"ok": False, "msg": NETWORK_FAIL_MSG}
        if self.qx.receiving_ticks:
            return {"ok": True, "msg": "লাইভ Quotex টিক ডেটা চলছে"}
        if self.qx.auth_state == "rejected":
            await self._stop_live_client()
            return {"ok": False, "msg": REJECTED_MSG}
        if not getattr(self.qx, "ever_opened", False):
            return {"ok": False, "msg": NETWORK_FAIL_MSG}
        return {"ok": False, "msg": "সংযোগ হয়েছে কিন্তু টিক ডেটা এখনো আসেনি — কয়েক সেকেন্ড পর আবার দেখুন"}

    async def _auto_connect(self, token):
        try:
            r = await self.start_live(token)
            if r.get("ok"):
                self.log("info", "QX_TOKEN দিয়ে স্বয়ংক্রিয় Quotex সংযোগ সফল")
            else:
                self.log("warn", f"QX_TOKEN সংযোগ: {r.get('msg')}")
        except Exception as e:
            self.log("warn", f"অটো-কানেক্ট ত্রুটি: {e}")

    async def stop_live(self):
        await self._stop_live_client()
        self.emit("status", self.status_snapshot())

    async def _stop_live_client(self):
        if self.qx is not None:
            try:
                await self.qx.close()
            except Exception:
                pass
            self.qx = None
        for p in list(self.feed_owner):
            if self.feed_owner[p] == "quotex":
                self.feed_owner[p] = "yahoo"
        # Quotex বিচ্ছিন্ন → পরে পুনঃসংযোগে নতুন করে পার্জ+রিপ্লেস হবে
        self._qx_purged.clear()
        self._page_empty.clear()
        self._page_done.clear()

    def on_quotex_tick(self, pair: str, price: float, t: int):
        store = self.stores.get(pair)
        if store is None:
            return
        self.last_live_tick_at = t
        if self.feed_owner.get(pair) != "quotex":
            self.feed_owner[pair] = "quotex"
            self.log("info", f"লাইভ Quotex টিক ডেটা সক্রিয় হলো ({pair})")
            self.emit("status", self.status_snapshot())
        self._on_tick(pair, price, t)
        self._tick_dirty.add(pair)   # ফাস্ট-পাথ: ১০Hz-এ ব্রাউজারে যাবে

    def on_quotex_candles(self, pair: str, candles):
        """Quotex-এর নিজস্ব ১-মিনিট ক্যান্ডেল — চার্টের একমাত্র সত্য এখন।

        ⭐ ১০০% Quotex-ম্যাচ গ্যারান্টি: প্রথমবার এলে ওই পেয়ারের সব পুরনো
        (Yahoo/মিশ্র) ক্যান্ডেল DB + স্টোর থেকে মুছে দিয়ে শুধুই Quotex-এর
        হিস্ট্রি বসানো হয় (আগে পুরনোগুলো থেকে যেত — OTC ফিডের সাথে কখনোই
        মিলত না, আর INSERT OR IGNORE থাকায় ভুল দাম সঠিকটাকে ব্লকও করত)।
        """
        store = self.stores.get(pair)
        if store is None or not candles:
            return
        self.feed_owner[pair] = "quotex"
        mapped = []
        for c in candles:
            if c["o"] is None or c["c"] is None:
                continue
            tk = int(c.get("tk") or 0)
            mapped.append(make_candle(pair, (c["t"] // MINUTE) * MINUTE, c["o"],
                                      max(c["h"], c["o"], c["c"]), min(c["l"], c["o"], c["c"]),
                                      c["c"], ticks=tk, source="QX"))
        if not mapped:
            return
        if pair not in self._qx_purged:
            # ফুল-রিপ্লেস: DB-তে পেয়ারের সব পুরনো ক্যান্ডেল মুছে Quotex-সেট বসাই
            try:
                self.db.delete_pair_candles(pair)
            except Exception:
                pass
            self._qx_purged.add(pair)
            self._page_empty[pair] = 0
            self.log("info", f"[{pair}] Quotex হিস্ট্রি বসছে — পুরনো (Yahoo/মিশ্র) "
                            "ক্যান্ডেল সরিয়ে ১০০% Quotex ডেটা")
            store.candles = []   # রানিং-ক্যান্ডেল অক্ষত — সেটাও Quotex-টিক থেকেই চলছে
        # মার্জ: নতুন Quotex-পেলোডই সর্বদা বিজয়ী — জেনারেশন-রোটেশন বা রিপোলের
        # পরে পুরনো ভুল মান নতুন ক্যানোনিক্যাল মানে বদলে যাবে (সেলফ-হিলিং)
        by_ts = {c["ts"]: c for c in store.candles}
        new, upd = 0, 0
        for c in mapped:
            old = by_ts.get(c["ts"])
            if old is None:
                by_ts[c["ts"]] = c
                new += 1
            elif old != c:
                by_ts[c["ts"]] = c
                upd += 1
        if new or upd:
            store.candles = sorted(by_ts.values(), key=lambda x: x["ts"])[-store.max_keep:]
            try:
                self.db.upsert_candles([c for c in mapped if by_ts.get(c["ts"]) is c])
            except Exception:
                pass
            self.log("info", f"[{pair}] Quotex থেকে {new}টি নতুন হিস্টোরিক্যাল ক্যান্ডেল "
                            f"(+{upd} রিফাইন) — মোট {len(store.candles)}")
            self._tick_dirty.add(pair)
            self.emit("market", self.snapshot())
        # ডিপ-হিস্ট্রি পেজিং-এর খালি-পেজ কাউন্টার
        if pair in self._page_empty and not new and not upd:
            self._page_empty[pair] = self._page_empty.get(pair, 0) + 1

    # ---------------- Yahoo feed ----------------

    async def _on_yahoo_bars(self, pair: str, bars):
        if pair not in self.stores or not bars:
            return
        if self.feed_owner.get(pair) == "quotex" and self._qx_fresh(pair):
            return
        if self.feed_owner.get(pair) != "quotex":
            self.feed_owner[pair] = "yahoo"
        store = self.stores[pair]
        now_ms = int(time.time() * 1000)
        cur_minute = now_ms // MINUTE * MINUTE
        last_closed_ts = store.candles[-1]["ts"] if store.candles else 0

        # fully-closed bars → candle close pipeline (signal resolution + new signals)
        for (ts, o, h, l, c) in bars:
            if ts > last_closed_ts and ts < cur_minute:
                up = 1 if c >= o else 0
                candle = make_candle(pair, ts, o, h, l, c, ticks=1,
                                     up_ticks=up, down_ticks=1 - up, source="LIVE")
                self._finalize_closed_candle(pair, candle, already_appended=False)

        # running candle from the newest (in-progress) bar — ONLY the current minute
        ts, o, h, l, c = bars[-1]
        if ts >= cur_minute:
            run = store.running
            if run is None or run.ts != ts:
                store.start_running(ts, o)
                run = store.running
                run.high, run.low, run.last = h, l, c
                run.ticks = 1
            else:
                prev = run.last
                run.high = max(run.high, h)
                run.low = min(run.low, l)
                run.last = c
                run.ticks += 1
                if c > prev:
                    run.up_ticks += 1
                elif c < prev:
                    run.down_ticks += 1
                sec = min(59, max(0, (now_ms - run.ts) // 1000))
                color = "GREEN" if c > run.open else ("RED" if c < run.open else (run.sec_colors[sec] or "FLAT"))
                run.sec_colors[sec] = color
                run.last_tick_at = now_ms
        self._tick_dirty.add(pair)   # ফাস্ট-পাথে ব্রাউজারে যাবে

    # ---------------- tick & minute pipeline ----------------

    def _on_tick(self, pair: str, price: float, t: int):
        store = self.stores.get(pair)
        if store is None:
            return
        minute = (t // MINUTE) * MINUTE
        if not store.running or store.running.ts != minute:
            if store.running and store.running.ts > minute:
                return
            open_ref = (store.running.last if store.running
                        else (store.candles[-1]["close"] if store.candles else price))
            # রেস-ফিক্স: নতুন মিনিটের প্রথম টিক-ই আগের ক্যান্ডেল ক্লোজ করে।
            # আগে শুধু মিনিট-ওয়াচার (২০০ms চক্র) ক্লোজ করত — কিন্তু টিক আগে
            # এসে running বদলে দিলে পুরনো ক্যান্ডেল চুপচাপ হারিয়ে যেত (মিনিট
            # ফাঁক, সিগন্যাল বাদ, চার্টে গ্যাপ)। এখন যে-পথ আগে পৌঁছায় সে-ই ক্লোজ করে।
            if store.running and store.running.ts < minute:
                candle = store.close_current(t, "LIVE")
                if candle is not None:
                    try:
                        self._finalize_closed_candle(pair, candle, already_appended=True)
                    except Exception as e:
                        self.log("warn", f"[{pair}] টিক-পাথ ক্যান্ডেল ক্লোজ ত্রুটি: {e}")
            if not store.running:
                store.start_running(minute, open_ref)
        store.running.on_tick(t, price)

    async def _minute_watcher(self):
        while True:
            try:
                await asyncio.sleep(0.2)
                now = int(time.time() * 1000)
                cur = now // MINUTE
                if cur <= self.last_minute:
                    continue
                closed_minute = self.last_minute
                self.last_minute = cur
                for sym in list(self.stores.keys()):
                    store = self.stores[sym]
                    if self.feed_owner.get(sym) == "yahoo":
                        # yahoo pairs: closed bars arrive via poll; keep running fresh
                        if store.running and store.running.ts < (cur - 3) * MINUTE:
                            store.start_running(cur * MINUTE, store.running.last)
                        continue
                    run_ts = store.running.ts if store.running else 0
                    if store.running and run_ts <= closed_minute * MINUTE:
                        candle = store.close_current(now, "LIVE")
                        self._finalize_closed_candle(sym, candle, already_appended=True)
                    last_close = (store.candles[-1]["close"] if store.candles
                                  else get_pair_def(sym)["basePrice"])
                    if not store.running or store.running.ts != cur * MINUTE:
                        store.start_running(cur * MINUTE, last_close)
                    self._tick_dirty.add(sym)   # নতুন মিনিটের ক্যান্ডেল সাথে সাথেই চার্টে
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log("warn", f"মিনিট-ওয়াচার ত্রুটি: {e}")

    def _finalize_closed_candle(self, sym: str, candle, already_appended: bool):
        store = self.stores.get(sym)
        if store is None or candle is None:
            return
        if not already_appended:
            if store.candles and candle["ts"] <= store.candles[-1]["ts"]:
                return
            store.append_closed(candle)
        try:
            self.db.insert_candles([candle])
        except Exception:
            pass

        # 1) resolve previous pending signal with THIS candle's close
        pend = self.pending.get(sym)
        if pend and pend["ts"] == candle["ts"] - MINUTE:
            pend["closePrice"] = candle["close"]
            if candle["close"] == pend["entryPrice"]:
                pend["result"] = "TIE"
            elif pend["direction"] == "CALL":
                pend["result"] = "WIN" if candle["close"] > pend["entryPrice"] else "LOSS"
            else:
                pend["result"] = "WIN" if candle["close"] < pend["entryPrice"] else "LOSS"
            self.pending.pop(sym, None)
            try:
                self.db.update_signal_result(pend["id"], candle["close"], pend["result"])
            except Exception:
                pass
            self.emit("signal:resolved", pend)
            self.log("info", f"[{sym}] {pend['direction']} সিগন্যাল "
                            f"{'উইন ✓' if pend['result'] == 'WIN' else 'লস ✗' if pend['result'] == 'LOSS' else 'টাই'} "
                            f"({pend['confidence']}%)")

        # 2) evaluate new signal at FULL candle close
        pdef = get_pair_def(sym)
        ev = evaluate_signal(store.candles, len(store.candles) - 1, pdef)
        if ev and ev["score"] >= self.min_confidence:
            rec = make_signal(f"sig_{sym}_{candle['ts']}", sym, candle["ts"] + MINUTE,
                              ev["direction"], ev["score"], ev["score"], ev["reasons"],
                              candle["close"], None, "PENDING", "LIVE")
            self.pending[sym] = rec
            self.signals_generated += 1
            try:
                self.db.insert_signal(rec)
            except Exception:
                pass
            self.emit("signal:new", rec)
            self.log("info", f"[{sym}] নতুন সিগন্যাল: {rec['direction']} @ "
                            f"{rec['entryPrice']:.{pdef['digits']}f} ({ev['score']}% কনফিডেন্স)")

        self.emit("candle:closed", {"pair": sym, "candle": candle})

    # ---------------- broadcast & snapshots ----------------

    async def _broadcast_loop(self):
        while True:
            await asyncio.sleep(1)
            try:
                self.emit("market", self.snapshot())
            except Exception as e:
                self.log("warn", f"ব্রডকাস্ট ত্রুটি: {e}")

    async def _tick_broadcast_loop(self):
        """ফাস্ট-পাথ: নতুন টিক পাওয়া পেয়ারগুলোকে ১০Hz-এ ব্রাউজারে পাঠায়।

        Quotex থেকে ৮-১২ টিক/সেকেন্ড আসে — প্রতি টিকে আলাদা socket ইভেন্ট
        পাঠালে ৮ পেয়ারে সেকেন্ডে ~১০০ প্যাকেট হয়ে যায়; তাই ১০০ms-এর
        ব্যাচে পাঠাই (সর্বোচ্চ ১০০ms বিলম্ব, ব্রাউজারে rAF-ইন্টারপোলেশন
        ৬০fps মোশন বানায়)।"""
        while True:
            await asyncio.sleep(0.1)
            try:
                if not self._tick_dirty:
                    continue
                dirty = self._tick_dirty
                self._tick_dirty = set()
                now = int(time.time() * 1000)
                quotes = []
                for sym in dirty:
                    store = self.stores.get(sym)
                    run = store.running if store else None
                    if run is None:
                        continue
                    quotes.append({
                        "p": sym, "ts": run.ts,
                        "o": run.open, "h": run.high, "l": run.low, "c": run.last,
                        "tk": run.ticks, "up": run.up_ticks, "dn": run.down_ticks,
                        "t": now,
                    })
                if quotes:
                    self.emit("ticks", {"t": now, "q": quotes})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log("warn", f"টিক-ব্রডকাস্ট ত্রুটি: {e}")

    def _feed(self) -> str:
        if self._qx_fresh_any():
            return "quotex"
        if self._market_fresh():
            return "market"
        return "none"

    def _qx_fresh_any(self) -> bool:
        return (self.qx is not None and self.qx.connected and self.qx.auth_state == "ok"
                and int(time.time() * 1000) - self.last_live_tick_at < 15_000)

    def _market_fresh(self) -> bool:
        now = time.time()
        return any(now - t < 240 for t in self.yahoo.last_ok.values())

    def status_snapshot(self) -> dict:
        feed = self._feed()
        qx_state = "none"
        if self.qx is not None:
            qx_state = self.qx.auth_state  # idle|pending|ok|rejected
        return {
            "mode": "LIVE" if feed in ("quotex", "market") else "CONNECTING",
            "desiredMode": "live",
            "feedProvider": feed,
            "qxAuthState": qx_state,
            "liveConnected": feed == "quotex",
            "accountMode": self.account_mode,
            "isDemo": 0 if self.account_mode == "real" else 1,
            "socketClients": self.socket_clients,
            "serverTime": int(time.time() * 1000),
            "accountBalance": self.account["balance"],
            "currency": self.account["currency"],
            "login": self.account["login"],
            "activePairs": list(self.active_pairs),
            "minConfidence": self.min_confidence,
            "uptimeSec": int((time.time() * 1000 - self.started_at) / 1000),
            "historyMinutes": 720,
        }

    def snapshot(self) -> dict:
        now = int(time.time() * 1000)
        pairs = []
        for sym in self.active_pairs:
            pdef = get_pair_def(sym)
            store = self.stores.get(sym)
            if store is None:
                continue
            run = store.running
            last_closed = store.candles[-1] if store.candles else None
            price = (run.last if run else (last_closed["close"] if last_closed else pdef["basePrice"]))
            zones = detect_zones(store.candles, pdef["pip"], price)
            pip = pdef["pip"]

            if run:
                near = None
                for z in zones:
                    d = (price - z["price"]) / pip
                    if near is None or abs(d) < abs(near["d"]):
                        near = {"z": z, "d": d}
                live = run.to_pseudo_candle("LIVE")
                preview = preview_running_score(store.candles, live, pdef)
                running = {
                    "pair": sym, "ts": run.ts,
                    "open": run.open, "high": run.high, "low": run.low, "last": run.last,
                    "secondsLeft": 60 - ((now - run.ts) % MINUTE) // 1000,
                    "color": run.color,
                    "ticks": run.ticks, "upTicks": run.up_ticks, "downTicks": run.down_ticks,
                    "tickImbalance": round((run.up_ticks - run.down_ticks) / run.ticks, 2) if run.ticks else 0,
                    "momentum5s": run.momentum(5, pip, now),
                    "momentum10s": run.momentum(10, pip, now),
                    "colorFlips": len(run.flips),
                    "lastFlipAtSec": run.flips[-1] if run.flips else -1,
                    "upperWickPips": round((run.high - max(run.open, run.last)) / pip, 1),
                    "lowerWickPips": round((min(run.open, run.last) - run.low) / pip, 1),
                    "nearZone": ({"side": near["z"]["side"], "price": near["z"]["price"],
                                  "distancePips": round(near["d"], 1), "strength": near["z"]["strength"]}
                                 if near and abs(near["d"]) < 30 else None),
                    "liveScore": ({"direction": preview["direction"], "score": preview["score"],
                                   "reasons": preview["reasons"]} if preview else None),
                }
            else:
                running = {
                    "pair": sym, "ts": now, "open": price, "high": price, "low": price,
                    "last": price, "secondsLeft": 0, "color": "FLAT", "ticks": 0,
                    "upTicks": 0, "downTicks": 0, "tickImbalance": 0, "momentum5s": 0,
                    "momentum10s": 0, "colorFlips": 0, "lastFlipAtSec": -1,
                    "upperWickPips": 0, "lowerWickPips": 0, "nearZone": None, "liveScore": None,
                }

            pairs.append({
                "pair": sym, "name": pdef["name"], "digits": pdef["digits"], "price": price,
                "changePips1m": (round((last_closed["close"] - last_closed["open"]) / pip, 1)
                                if last_closed else 0),
                "running": running, "lastClosed": last_closed,
            })

        return {
            "status": self.status_snapshot(),
            "pairs": pairs,
            "pendingSignals": list(self.pending.values()),
        }

    def get_history(self, pair: str, limit: int = 500):
        store = self.stores.get(pair)
        if store is None:
            return []
        closed = store.candles[-limit:] if limit else list(store.candles)
        if store.running and (not closed or store.running.ts > closed[-1]["ts"]):
            run = store.running
            closed.append(make_candle(pair, run.ts, run.open, run.high, run.low, run.last,
                                      run.ticks, run.up_ticks, run.down_ticks,
                                      flip_count=len(run.flips), source="LIVE"))
        return closed

    # ---------------- signals & stats (DB) ----------------

    def get_signals(self, f):
        return self.db.query_signals(
            pair=f.get("pair", "ALL"), direction=f.get("direction", "ALL"),
            period_h=f.get("periodH", 0) or 0,
            sources=f.get("source") or ["LIVE"], limit=f.get("limit", 100) or 100)

    def get_stats(self, f):
        rows = self.db.query_signals(
            pair="ALL", direction="ALL",
            period_h=f.get("periodH", 0) or 0,
            sources=f.get("source") or ["LIVE"], limit=3000)

        def mk(lst):
            wins = sum(1 for r in lst if r["result"] == "WIN")
            losses = sum(1 for r in lst if r["result"] == "LOSS")
            ties = sum(1 for r in lst if r["result"] == "TIE")
            pending = sum(1 for r in lst if r["result"] == "PENDING")
            call = [r for r in lst if r["direction"] == "CALL"]
            put = [r for r in lst if r["direction"] == "PUT"]
            cw = sum(1 for r in call if r["result"] == "WIN")
            pw = sum(1 for r in put if r["result"] == "WIN")
            cl = sum(1 for r in call if r["result"] == "LOSS")
            pl = sum(1 for r in put if r["result"] == "LOSS")
            chrono = sorted([r for r in lst if r["result"] in ("WIN", "LOSS")], key=lambda r: r["ts"])
            cur = cur_type = 0
            max_w = max_l = 0
            for r in chrono:
                t = "W" if r["result"] == "WIN" else "L"
                if t == cur_type:
                    cur += 1
                else:
                    cur_type, cur = t, 1
                if t == "W":
                    max_w = max(max_w, cur)
                else:
                    max_l = max(max_l, cur)
            decided = wins + losses

            def wr(w, d):
                return js_round((w / d) * 100) if d else 0

            return {
                "total": len(lst), "wins": wins, "losses": losses, "ties": ties, "pending": pending,
                "winRate": wr(wins, decided),
                "call": {"total": len(call), "wins": cw, "losses": cl,
                         "ties": sum(1 for r in call if r["result"] == "TIE"), "winRate": wr(cw, cw + cl)},
                "put": {"total": len(put), "wins": pw, "losses": pl,
                        "ties": sum(1 for r in put if r["result"] == "TIE"), "winRate": wr(pw, pw + pl)},
                "streak": {"current": cur if cur_type else 0, "maxWin": max_w, "maxLoss": max_l,
                           "currentType": cur_type or None},
            }

        overall = mk(rows)
        per_pair = [dict(mk([r for r in rows if r["pair"] == sym]), pair=sym)
                    for sym in self.active_pairs]
        return {"overall": overall, "perPair": per_pair}

    # ---------------- settings ----------------

    async def save_settings(self, patch):
        if patch.get("minConfidence") is not None:
            try:
                self.min_confidence = max(50, min(95, js_round(float(patch["minConfidence"]))))
            except (TypeError, ValueError):
                pass
        acct = str(patch.get("accountMode") or "").strip().lower()
        acct_changed = acct in ("demo", "real") and acct != self.account_mode
        if acct_changed:
            self.account_mode = acct
            self.log("info", f"অ্যাকাউন্ট-টাইপ: {'রিয়েল' if acct == 'real' else 'ডেমো'} — "
                            "Quotex ফিড পুনঃসংযোগ হচ্ছে")
        new_pairs = patch.get("pairs")
        if new_pairs:
            valid = [p for p in new_pairs if any(d["symbol"] == p for d in ALL_PAIRS)]
            if valid:
                for sym in valid:
                    if sym not in self.stores:
                        self.active_pairs.append(sym)
                        self.stores[sym] = PairCandleStore(sym)
                        self.feed_owner[sym] = "yahoo"
                        self.log("info", f"[{sym}] পেয়ার সক্রিয় করা হলো")
                        self._tasks.append(asyncio.create_task(self._bootstrap_pair(sym)))
                for sym in list(self.stores.keys()):
                    if sym not in valid:
                        self.stores.pop(sym, None)
                        self.feed_owner.pop(sym, None)
                        self.pending.pop(sym, None)
                        self.active_pairs = [p for p in self.active_pairs if p != sym]
                        self.log("info", f"[{sym}] পেয়ার বন্ধ করা হলো")
                if self.qx is not None:
                    self.qx.set_pairs(self.active_pairs)
                    # re-subscribe with the new pair list
                    await self.qx.close()
                    self.qx = None
                    if self.qx_token:
                        self._tasks.append(asyncio.create_task(self._auto_connect(self.qx_token)))
        try:
            self.db.update_setting(minConfidence=self.min_confidence,
                                   mode="live",
                                   accountMode=self.account_mode,
                                   pairs=",".join(self.active_pairs))
        except Exception:
            pass
        # অ্যাকাউন্ট-টাইপ বদলালে লাইভ ফিড নতুন isDemo-তে পুনঃসংযোগ
        if acct_changed and self.qx_token:
            self._tasks.append(asyncio.create_task(self._auto_connect(self.qx_token)))
        self.emit("status", self.status_snapshot())
        return {"ok": True, "msg": "সেটিংস সংরক্ষিত"}

    def get_token_masked(self) -> str:
        t = self.qx_token or ""
        if not t:
            return ""
        return t if len(t) <= 10 else f"{t[:6]}••••••{t[-4:]}"

    def get_settings(self):
        return {
            "tokenMasked": self.get_token_masked(),
            "tokenSource": self.token_source,
            "mode": "live",
            "minConfidence": self.min_confidence,
            "pairs": list(self.active_pairs),
            "accountMode": self.account_mode,
            "allPairs": [{"symbol": p["symbol"], "name": p["name"]} for p in ALL_PAIRS],
        }

    # ---------------- backtest ----------------

    async def run_backtest(self):
        t0 = time.time()
        self.db.delete_signals(["BACKTEST"])
        per_pair = []
        all_signals = []
        candles_tested = 0
        from_ts = None
        to_ts = None

        for sym in self.active_pairs:
            pdef = get_pair_def(sym)
            hist = self.db.load_candles(sym, 2000)
            if len(hist) < 60:
                continue
            signals, result = backtest_pair(sym, hist, pdef, self.min_confidence)
            per_pair.append(result)
            all_signals.extend(signals)
            candles_tested += len(hist)
            from_ts = hist[0]["ts"] if from_ts is None else min(from_ts, hist[0]["ts"])
            to_ts = hist[-1]["ts"] if to_ts is None else max(to_ts, hist[-1]["ts"])
            for s in signals[-400:]:
                db_rec = make_signal(f"bt_{sym}_{s['ts']}", sym, s["ts"], s["direction"],
                                     s["score"], s["score"], s["reasons"], s["entryPrice"],
                                     s["closePrice"], s["result"], "BACKTEST")
                db_rec["backtestId"] = "bt"
                try:
                    self.db.insert_signal(db_rec)
                except Exception:
                    pass

        summary = aggregate_backtest(f"bt_{int(time.time()*1000)}", self.min_confidence,
                                     per_pair, all_signals, candles_tested,
                                     from_ts or 0, to_ts or 0)
        try:
            self.db.update_setting(lastBacktest=json.dumps(summary, ensure_ascii=False))
        except Exception:
            pass
        self.log("info", f"ব্যাকটেস্ট সম্পন্ন {time.time()-t0:.1f}s — "
                        f"{summary['overall']['signals']} সিগন্যাল, উইন রেট {summary['overall']['winRate']}%")
        return summary

    def get_last_backtest(self):
        s = self.db.ensure_settings()
        raw = s.get("lastBacktest")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    # ---------------- logs ----------------

    def log(self, level, msg):
        self.logs.append({"t": int(time.time() * 1000), "level": level, "msg": msg})
        if len(self.logs) > 250:
            del self.logs[:len(self.logs) - 250]
        self.emit("log", self.logs[-1])
        print(f"[qx-engine] {msg}")

    def push_raw(self, line):
        self.raw_log.append(line)
        if len(self.raw_log) > 120:
            del self.raw_log[:len(self.raw_log) - 120]

    def get_logs(self):
        return self.logs[-100:]

    def get_raw_log(self):
        return self.raw_log[-60:]


def _getenv(name):
    import os
    return os.environ.get(name)


class _CanaryEvents(QuotexEvents):
    """ক্যানারি-সংযোগের ক্যান্ডেল + লাইভ-টিক সংগ্রাহক (ফিড-জেনারেশন যাচাই)।"""

    def __init__(self):
        self.candles = {}    # pair → {ts_ms: {o,h,l,c}}
        self.last_ticks = {}  # pair → শেষ লাইভ টিকের দাম

    def on_candles(self, pair, candles):
        by_ts = self.candles.setdefault(pair, {})
        for c in candles:
            if c.get("o") is None or c.get("c") is None:
                continue
            by_ts[(c["t"] // 60000) * 60000] = c

    def on_tick(self, pair, price, t):
        self.last_ticks[pair] = price


class _EngineQuotexEvents(QuotexEvents):
    def __init__(self, engine: MarketEngine):
        self.e = engine

    def on_tick(self, pair, price, t):
        self.e.on_quotex_tick(pair, price, t)

    def on_candles(self, pair, candles):
        self.e.on_quotex_candles(pair, candles)

    def on_balance(self, balance, currency):
        self.e.account["balance"] = balance
        self.e.account["currency"] = currency
        self.e.emit("status", self.e.status_snapshot())

    def on_status(self, connected, reason):
        if reason == "rejected":
            self.e.log("warn", "Quotex সংযোগ: টোকেন প্রত্যাখ্যাত (মেয়াদ শেষ/ভুল)")
        else:
            self.e.log("info" if connected else "warn",
                       f"Quotex সংযোগ: {'সক্রিয়' if connected else reason}")
        self.e.emit("status", self.e.status_snapshot())

    def on_raw(self, line):
        self.e.push_raw(line)

    def on_log(self, msg):
        self.e.log("info", msg)
