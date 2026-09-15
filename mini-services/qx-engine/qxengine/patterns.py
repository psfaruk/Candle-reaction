"""Candle pattern analysis — exact port of the TS patterns.ts.

Body/wick anatomy, CLV, pin bars, engulfing, late color-flip,
tick imbalance inside the closed candle.
"""


def analyze_pattern(candles, i: int, pip: float) -> dict:
    c = candles[i]
    prev = candles[i - 1] if i > 0 else None

    rng = c["high"] - c["low"]
    body = abs(c["close"] - c["open"])
    upper_wick = c["high"] - max(c["open"], c["close"])
    lower_wick = min(c["open"], c["close"]) - c["low"]

    range_pips = rng / pip
    body_pips = body / pip

    clv = ((c["close"] - c["low"] - (c["high"] - c["close"])) / rng) if rng > 0 else 0.0

    is_bull = c["close"] > c["open"]
    is_bear = c["close"] < c["open"]
    body_ratio = (body / rng) if rng > 0 else 0.0
    is_doji = body_ratio <= 0.12
    is_marubozu = body_ratio >= 0.85

    is_pin_bull = lower_wick / (rng or 1) >= 0.5 and clv >= 0.2
    is_pin_bear = upper_wick / (rng or 1) >= 0.5 and clv <= -0.2

    is_engulf_bull = bool(
        prev and prev["close"] < prev["open"] and c["close"] > c["open"]
        and c["close"] >= prev["high"] and c["open"] <= prev["close"])
    is_engulf_bear = bool(
        prev and prev["close"] > prev["open"] and c["close"] < c["open"]
        and c["close"] <= prev["low"] and c["open"] >= prev["close"])

    ticks = c.get("ticks", 0) or 0
    up = c.get("upTicks", 0) or 0
    down = c.get("downTicks", 0) or 0
    tick_imbalance = ((up - down) / ticks) if ticks > 0 else 0.0

    return {
        "bodyPips": body_pips,
        "rangePips": range_pips,
        "upperWickPips": upper_wick / pip,
        "lowerWickPips": lower_wick / pip,
        "bodyRatio": body_ratio,
        "clv": clv,
        "isBull": is_bull,
        "isBear": is_bear,
        "isPinBull": is_pin_bull,
        "isPinBear": is_pin_bear,
        "isEngulfBull": is_engulf_bull,
        "isEngulfBear": is_engulf_bear,
        "isDoji": is_doji,
        "isMarubozu": is_marubozu,
        "tickImbalance": tick_imbalance,
        "lateFlip": c.get("lateFlip", 0),
        "lateMomentumPips": c.get("lateMomentum", 0.0),
    }
