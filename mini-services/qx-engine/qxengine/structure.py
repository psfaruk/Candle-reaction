"""Market structure analysis — exact port of the TS structure.ts.

EMA(9/21) trend + swing (HH/HL vs LH/LL) structure + pullback detection.
"""


def _ema(values, period: int):
    if not values:
        return float("nan")
    k = 2.0 / (period + 1)
    e = values[0]
    for i in range(1, len(values)):
        e = values[i] * k + e * (1 - k)
    return e


def analyze_structure(candles, pip: float) -> dict:
    n = len(candles)
    closes = [c["close"] for c in candles]
    ema_fast = _ema(closes[-40:], 9)
    ema_slow = _ema(closes[-60:], 21)

    # swings over last ~80 candles
    look = min(n - 2, 80)
    swing_highs = []
    swing_lows = []
    for i in range(max(2, n - look), n - 2):
        c = candles[i]
        is_high = True
        is_low = True
        for k in (1, 2):
            if candles[i - k]["high"] >= c["high"] or candles[i + k]["high"] >= c["high"]:
                is_high = False
            if candles[i - k]["low"] <= c["low"] or candles[i + k]["low"] <= c["low"]:
                is_low = False
        if is_high:
            swing_highs.append(c["high"])
        if is_low:
            swing_lows.append(c["low"])

    swing_trend = "RANGE"
    if len(swing_highs) >= 2 and len(swing_lows) >= 2:
        hh = swing_highs[-1] > swing_highs[-2]
        hl = swing_lows[-1] > swing_lows[-2]
        lh = swing_highs[-1] < swing_highs[-2]
        ll = swing_lows[-1] < swing_lows[-2]
        if hh and hl:
            swing_trend = "UP"
        elif lh and ll:
            swing_trend = "DOWN"

    last = candles[n - 1]
    ema_gap_pips = (ema_fast - ema_slow) / pip
    trend = "RANGE"
    if ema_gap_pips > 1.2:
        trend = "UP"
    elif ema_gap_pips < -1.2:
        trend = "DOWN"

    strength = 30
    if trend != "RANGE":
        strength += 25
    if swing_trend == trend and trend != "RANGE":
        strength += 25
    above_fast = last["close"] > ema_fast
    if (trend == "UP" and above_fast) or (trend == "DOWN" and not above_fast):
        strength += 20

    last4 = candles[-4:]
    pullback = False
    if trend == "UP":
        dipped = any(c["low"] <= ema_slow + 2 * pip or c["low"] <= ema_fast for c in last4)
        pullback = dipped and last["close"] > ema_fast and last["close"] > last["open"]
    elif trend == "DOWN":
        spiked = any(c["high"] >= ema_slow - 2 * pip or c["high"] >= ema_fast for c in last4)
        pullback = spiked and last["close"] < ema_fast and last["close"] < last["open"]

    consecutive_bull = 0
    consecutive_bear = 0
    for i in range(n - 1, max(-1, n - 10) - 1, -1):
        if candles[i]["close"] > candles[i]["open"]:
            consecutive_bull += 1
        else:
            break
    for i in range(n - 1, max(-1, n - 10) - 1, -1):
        if candles[i]["close"] < candles[i]["open"]:
            consecutive_bear += 1
        else:
            break

    return {
        "trend": trend,
        "emaFast": ema_fast,
        "emaSlow": ema_slow,
        "swingTrend": swing_trend,
        "strength": min(100, strength),
        "atrPips": 0.0,  # filled by caller
        "consecutiveBull": consecutive_bull,
        "consecutiveBear": consecutive_bear,
        "pullback": pullback,
    }
