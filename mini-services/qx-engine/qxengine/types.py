"""Shared types + helpers — exact port of the TS engine semantics."""

MINUTE = 60_000
DAY = 86_400_000
HISTORY_MINUTES = 2880  # 2 days
LIVE_TICK_TIMEOUT = 15_000


def js_round(x: float) -> int:
    """JS Math.round equivalent."""
    import math
    return int(math.floor(x + 0.5))


def fmt_price(price: float, digits: int) -> str:
    return f"{price:.{digits}f}"


def make_candle(pair, ts, open_, high, low, close, ticks=0, up_ticks=0, down_ticks=0,
                late_flip=0, late_momentum=0.0, flip_count=0, source="LIVE"):
    return {
        "pair": pair, "ts": int(ts), "open": float(open_), "high": float(high),
        "low": float(low), "close": float(close), "ticks": int(ticks),
        "upTicks": int(up_ticks), "downTicks": int(down_ticks),
        "lateFlip": int(late_flip), "lateMomentum": float(late_momentum),
        "flipCount": int(flip_count), "source": source,
    }


def make_signal(sid, pair, ts, direction, confidence, score, reasons,
                entry_price, close_price, result, source):
    return {
        "id": sid, "pair": pair, "ts": int(ts), "direction": direction,
        "confidence": int(confidence), "score": int(score), "reasons": reasons,
        "entryPrice": entry_price, "closePrice": close_price, "result": result,
        "source": source,
    }
