"""Yahoo Finance real-market feed — 1-minute candles for FX pairs.

এটা সিমুলেশন নয় — একই পেয়ারের (EURUSD, USDJPY, …) রিয়েল ইন্টারব্যাঙ্ক মার্কেট ডেটা।
Quotex টোকেন না থাকলে / মেয়াদ শেষ হলে অ্যাপ কখনো খালি থাকবে না: চার্ট,
সিগন্যাল, উইনরেট, ব্যাকটেস্ট — সবই রিয়েল মার্কেট ক্যান্ডেলে চলে।
Quotex টোকেন সংযুক্ত হলে ওই পেয়ার Quotex-এর নিজস্ব টিক ফিডে চলে যায়।
"""

import asyncio
import time

import aiohttp

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

YAHOO_SYMBOL = {  # pair → Yahoo ticker
    "EURUSD": "EURUSD=X", "USDJPY": "USDJPY=X", "AUDUSD": "AUDUSD=X",
    "GBPUSD": "GBPUSD=X", "EURJPY": "EURJPY=X", "GBPJPY": "GBPJPY=X",
    "USDCAD": "USDCAD=X", "USDCHF": "USDCHF=X",
}

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range={rng}"


async def fetch_candles(session: aiohttp.ClientSession, pair: str, rng: str = "2d"):
    """Returns list of (ts_ms, open, high, low, close) — minute aligned, ascending."""
    sym = YAHOO_SYMBOL.get(pair)
    if not sym:
        return []
    url = CHART_URL.format(sym=sym, rng=rng)
    try:
        async with session.get(url, headers={"User-Agent": UA},
                               timeout=aiohttp.ClientTimeout(total=20)) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
    except Exception:
        return []
    try:
        r0 = data["chart"]["result"][0]
        ts_list = r0.get("timestamp") or []
        q = r0["indicators"]["quote"][0]
        opens, highs, lows, closes = q.get("open") or [], q.get("high") or [], q.get("low") or [], q.get("close") or []
    except (KeyError, IndexError, TypeError):
        return []
    out = []
    for i, t in enumerate(ts_list):
        try:
            o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        except IndexError:
            continue
        if None in (o, h, l, c):
            continue
        out.append((int(t) * 1000 // 60_000 * 60_000, float(o), float(h), float(l), float(c)))
    return out


class YahooFeed:
    """Polls 1m bars per active pair; feeds the market engine."""

    POLL_SEC = 25          # per-pair poll cadence (staggered)
    BOOTSTRAP_RANGE = "2d"

    def __init__(self, on_bars, log):
        self.on_bars = on_bars          # async cb(pair, bars)
        self.log = log
        self.session = None
        self._task = None
        self.stopped = False
        self.last_ok = {}               # pair → epoch s

    async def start(self):
        if self._task is not None:
            return
        if self.session is None:
            self.session = aiohttp.ClientSession()
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self.stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self.session is not None:
            await self.session.close()
            self.session = None

    async def fetch_once(self, pair: str, rng: str = None):
        if self.session is None:
            self.session = aiohttp.ClientSession()
        return await fetch_candles(self.session, pair, rng or self.BOOTSTRAP_RANGE)

    async def _loop(self):
        try:
            while not self.stopped:
                pairs = list(getattr(self, "active_pairs", []))
                for pair in pairs:
                    if self.stopped:
                        break
                    if getattr(self, "skip_pairs", None) and pair in self.skip_pairs:
                        self.last_ok.setdefault(pair, time.time())
                        continue
                    bars = await self.fetch_once(pair)
                    if bars:
                        self.last_ok[pair] = time.time()
                        try:
                            await self.on_bars(pair, bars)
                        except Exception as e:
                            self.log(f"[{pair}] Yahoo বার প্রসেস ত্রুটি: {e}")
                    await asyncio.sleep(2.5)  # stagger between pairs
                await asyncio.sleep(self.POLL_SEC)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.log(f"Yahoo ফিড বন্ধ: {e}")
