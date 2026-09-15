"""Running candle builder — exact port of the TS candle-store.

Tracks everything hidden inside a running 1-minute candle: per-second color
path (late color-flip detection), tick imbalance, 5s/10s momentum, wick
formation, flip count.
"""

import time
from collections import deque

from .types import MINUTE


class RunningCandle:
    def __init__(self, pair: str, ts: int, open_price: float):
        self.pair = pair
        self.ts = ts
        self.open = open_price
        self.high = open_price
        self.low = open_price
        self.last = open_price
        self.ticks = 0
        self.up_ticks = 0
        self.down_ticks = 0
        self.last_tick_at = 0
        self.sec_colors = ["FLAT"] * 60
        self.flips = []          # seconds at which color changed
        self.recent = deque()    # (t, price) — last ~22s of ticks

    def on_tick(self, t: int, price: float):
        if t < self.ts:
            return
        self.last_tick_at = t
        prev = self.last
        self.last = price
        if price > self.high:
            self.high = price
        if price < self.low:
            self.low = price
        self.ticks += 1
        if price > prev:
            self.up_ticks += 1
        elif price < prev:
            self.down_ticks += 1

        sec = min(59, int((t - self.ts) // 1000))  # int() — float index guard
        color = "GREEN" if price > self.open else ("RED" if price < self.open else (self.sec_colors[sec] or "FLAT"))
        prev_color = self.sec_colors[sec] or "FLAT"
        self.sec_colors[sec] = color
        if prev_color == "FLAT" and color != "FLAT":
            prev_colored = self._last_color_before(sec)
            if prev_colored and prev_colored != color:
                self.flips.append(sec)
        # momentum buffer
        self.recent.append((t, price))
        cutoff = t - 22_000
        while self.recent and self.recent[0][0] < cutoff:
            self.recent.popleft()

    def _last_color_before(self, sec: int):
        for s in range(sec - 1, -1, -1):
            c = self.sec_colors[s]
            if c and c != "FLAT":
                return c
        return None

    @property
    def color(self) -> str:
        if self.last > self.open:
            return "GREEN"
        if self.last < self.open:
            return "RED"
        return "FLAT"

    def _color_at_second(self, sec: int) -> str:
        for s in range(sec, -1, -1):
            c = self.sec_colors[s]
            if c and c != "FLAT":
                return c
        return "FLAT"

    def price_at(self, ms: int):
        for i in range(len(self.recent) - 1, -1, -1):
            if self.recent[i][0] <= ms:
                return self.recent[i][1]
        return self.recent[0][1] if self.recent else None

    def momentum(self, sec_back: int, pip: float, now: int) -> float:
        p = self.price_at(now - sec_back * 1000)
        if p is None:
            return 0
        return round((self.last - p) / pip, 2)

    def to_candle(self, source: str, now: int) -> dict:
        final_color = self.color
        color50 = self._color_at_second(50)
        late_flip = 0
        if (final_color != "FLAT" and color50 != "FLAT" and final_color != color50
                and (not self.flips or self.flips[-1] >= 50)):
            late_flip = 1 if final_color == "GREEN" else -1
        late_mom = self.momentum(10, 1, min(now, self.ts + MINUTE - 1))  # pip=1 → price units
        return {
            "pair": self.pair, "ts": self.ts,
            "open": self.open, "high": self.high, "low": self.low, "close": self.last,
            "ticks": self.ticks, "upTicks": self.up_ticks, "downTicks": self.down_ticks,
            "lateFlip": late_flip, "lateMomentum": late_mom,
            "flipCount": len(self.flips), "source": source,
        }

    def to_pseudo_candle(self, source: str) -> dict:
        final_color = self.color
        color50 = self._color_at_second(50)
        late_flip = 0
        sec_now = min(59, (int(time.time() * 1000) - self.ts) // 1000)
        if (final_color != "FLAT" and color50 != "FLAT" and final_color != color50
                and sec_now >= 52):
            late_flip = 1 if final_color == "GREEN" else -1
        return {
            "pair": self.pair, "ts": self.ts,
            "open": self.open, "high": self.high, "low": self.low, "close": self.last,
            "ticks": self.ticks, "upTicks": self.up_ticks, "downTicks": self.down_ticks,
            "lateFlip": late_flip, "lateMomentum": 0.0,
            "flipCount": len(self.flips), "source": source,
        }


class PairCandleStore:
    def __init__(self, pair: str, max_keep: int = 1000):
        self.pair = pair
        self.candles = []
        self.running = None
        self.max_keep = max_keep

    def on_tick(self, t: int, price: float) -> str:
        t = int(t)
        minute = (t // MINUTE) * MINUTE
        if not self.running or self.running.ts != minute:
            if self.running and self.running.ts > minute:
                return "ignored"
            self.running = RunningCandle(self.pair, minute, price)
            self.running.on_tick(t, price)
            return "new-candle"
        self.running.on_tick(t, price)
        return "updated"

    def close_current(self, now: int, source: str):
        if not self.running:
            return None
        candle = self.running.to_candle(source, now)
        self.append_closed(candle)
        self.running = None
        return candle

    def start_running(self, ts: int, open_price: float):
        self.running = RunningCandle(self.pair, ts, open_price)

    def append_closed(self, c: dict):
        # রেস-সুরক্ষা: টিক-পাথ আর মিনিট-ওয়াচার একসাথে ক্লোজ করলেও
        # একই টাইমস্ট্যাম্প দুইবার ঢুকবে না (ডুপ্লিকেট = চার্ট assertion ভাঙে)
        if self.candles and self.candles[-1]["ts"] >= c["ts"]:
            return
        self.candles.append(c)
        if len(self.candles) > self.max_keep:
            del self.candles[:len(self.candles) - self.max_keep]
