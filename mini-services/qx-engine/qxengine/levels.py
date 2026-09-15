"""Support/Resistance zone detection — exact port of the TS levels.ts.

Swing fractals clustered into zones + round-number levels.
"""

import math


def _js_round_half_up(x: float) -> float:
    """JS Math.round semantics (half away from zero for positives)."""
    return math.floor(x + 0.5)


def atr_pips(candles, pip: float) -> float:
    n = len(candles)
    if n < 2:
        return 0.0
    s = 0.0
    c = 0
    for i in range(max(1, n - 14), n):
        a, p = candles[i], candles[i - 1]
        s += max(a["high"] - a["low"], abs(a["high"] - p["close"]), abs(a["low"] - p["close"]))
        c += 1
    return (s / c) / pip if c else 0.0


def detect_zones(candles, pip: float, ref_price: float):
    n = len(candles)
    if n < 12:
        return []

    look = min(n - 2, 150)
    start_idx = n - look

    # ATR(14) in price units
    atr_sum = 0.0
    atr_cnt = 0
    for i in range(max(1, n - 14), n):
        c, p = candles[i], candles[i - 1]
        atr_sum += max(c["high"] - c["low"], abs(c["high"] - p["close"]), abs(c["low"] - p["close"]))
        atr_cnt += 1
    atr = (atr_sum / atr_cnt) if atr_cnt else 5 * pip
    tol = max(atr * 0.35, 2.5 * pip)

    # swing fractals (2 each side)
    swing_highs = []
    swing_lows = []
    for i in range(start_idx + 2, n - 2):
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

    zones = []

    def cluster(points):
        group = []

        def flush():
            if len(group) >= 2:
                avg = sum(group) / len(group)
                zones.append({
                    "price": round(avg, 6),
                    "side": "SUPPORT" if avg < ref_price else "RESISTANCE",
                    "strength": len(group),
                    "kind": "swing",
                })
            del group[:]

        for price in sorted(points):
            if group and price - group[-1] > tol:
                flush()
            group.append(price)
        flush()

    cluster(swing_highs)
    cluster(swing_lows)

    # round-number levels (25-pip grid) around current price
    grid = 25 * pip
    base = _js_round_half_up(ref_price / grid) * grid
    for k in range(-2, 3):
        if k == 0:
            continue
        price = base + k * grid
        if price <= 0:
            continue
        if not any(abs(z["price"] - price) < pip * 3 for z in zones):
            zones.append({
                "price": round(price, 6),
                "side": "SUPPORT" if price < ref_price else "RESISTANCE",
                "strength": 2,
                "kind": "round",
            })

    # dedupe close zones (merge strength), keep nearest each side
    merged = []
    for z in sorted(zones, key=lambda z: abs(z["price"] - ref_price)):
        near = next((m for m in merged if abs(m["price"] - z["price"]) <= tol * 0.8), None)
        if near:
            near["strength"] = min(9, near["strength"] + 1)
        else:
            merged.append(dict(z))
    sup = sorted([z for z in merged if z["side"] == "SUPPORT"], key=lambda z: -z["price"])[:4]
    res = sorted([z for z in merged if z["side"] == "RESISTANCE"], key=lambda z: z["price"])[:4]
    return sup + res


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x)
