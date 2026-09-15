"""Signal engine — confluence model (exact port of TS signal-engine.ts).

লেভেল/জোন + মার্কেট স্ট্রাকচার + ক্যান্ডেল ফুল ক্লোজ + রিয়েকশন = কনফার্মেশন.
Evaluation happens ONLY at a full candle close (never mid-candle).
The emitted signal predicts the NEXT 1-minute candle (binary CALL/PUT).
Pure function over candles[0..last] — identical code path for live signals
and walk-forward backtesting (no look-ahead bias).
"""

from .types import js_round
from .levels import detect_zones, atr_pips
from .structure import analyze_structure
from .patterns import analyze_pattern

MAX = {"ZONE": 30, "STRUCTURE": 25, "PATTERN": 30, "TICK": 15}


def evaluate_signal(candles, last: int, pdef: dict):
    if last < 25:  # warmup
        return None
    hist = candles[max(0, last - 159):last + 1]
    c = candles[last]
    pip = pdef["pip"]

    atr = atr_pips(hist, pip)
    if atr < 0.4:  # dead market
        return None
    zones = detect_zones(hist, pip, c["close"])
    st = analyze_structure(hist, pip)
    pat = analyze_pattern(candles, last, pip)

    # outlier / exhaustion guards
    if pat["rangePips"] > atr * 3.2:
        return None

    call = _score_side("CALL", c, zones, st, pat, atr, pip, pdef)
    put = _score_side("PUT", c, zones, st, pat, atr, pip, pdef)

    best = call if call["score"] >= put["score"] else put
    if best["score"] < 55:
        return None
    return {
        "direction": "CALL" if call["score"] >= put["score"] else "PUT",
        "score": js_round(best["score"]),
        "reasons": best["reasons"],
    }


def _score_side(direction, c, zones, st, pat, atr, pip, pdef):
    reasons = []
    want_bull = direction == "CALL"
    digits = pdef["digits"]

    # ---------- A. লেভেল / জোন (max 30) ----------
    tol = max(atr * 0.28, 2.2)
    relevant = [z for z in zones if z["side"] == ("SUPPORT" if want_bull else "RESISTANCE")]
    zone_pts = 0
    zone_detail = ""
    swept = False

    extreme = c["low"] if want_bull else c["high"]
    zone = None
    if relevant:
        dists = []
        for z in relevant:
            d = ((extreme - z["price"]) if want_bull else (z["price"] - extreme)) / pip
            dists.append((z, d))
        dists.sort(key=lambda t: abs(t[1]))
        zone, dist = dists[0]

    if zone is not None:
        dist = ((extreme - zone["price"]) if want_bull else (zone["price"] - extreme)) / pip
        touched = dist <= tol
        swept = (c["close"] < zone["price"] - atr * 0.5) if want_bull else (c["close"] > zone["price"] + atr * 0.5)
        if touched and not swept:
            zone_pts = 16 + min(10, zone["strength"] * 2)
            zone_detail = (
                f"{'সাপোর্ট' if want_bull else 'রেজিস্ট্যান্স'} জোন {zone['price']:.{digits}f} "
                f"({'রাউন্ড লেভেল' if zone['kind'] == 'round' else 'সুইং জোন'}, শক্তি {zone['strength']}) "
                f"টাচ করে {'উপরে' if want_bull else 'নিচে'} ক্লোজ"
            )
            pierced = (c["low"] < zone["price"] - atr * 0.25) if want_bull else (c["high"] > zone["price"] + atr * 0.25)
            if pierced:
                zone_pts = min(MAX["ZONE"], zone_pts + 6)
                zone_detail += " — জোন ভেদ করে ফিরে এসেছে (স্টপ-হান্ট সুইপ)"
        elif swept:
            zone_pts = 0
            zone_detail = "জোন ভেদ করে ক্লোজ — ব্রেকআউট ঝুঁকি"
        else:
            zone_pts = 0
            zone_detail = f"নিকটতম জোন থেকে দূরত্ব {abs(dist):.1f} পিপ"
    if zone_pts > 0:
        reasons.append({"name": "লেভেল/জোন", "detail": zone_detail, "points": js_round(zone_pts)})

    # ---------- B. মার্কেট স্ট্রাকচার (max 25) ----------
    struct_pts = 0
    struct_bits = []
    if want_bull:
        if st["trend"] == "UP":
            struct_pts += 15
            struct_bits.append("আপট্রেন্ড (EMA9>EMA21)")
        elif st["trend"] == "RANGE":
            struct_pts += 10
            struct_bits.append("রেঞ্জ মার্কেট")
        else:
            struct_bits.append("ডাউনট্রেন্ড — কাউন্টার-ট্রেন্ড ঝুঁকি")
        if st["swingTrend"] == "UP":
            struct_pts += 5
            struct_bits.append("HH/HL সুইং স্ট্রাকচার")
        if st["pullback"] and st["trend"] == "UP":
            struct_pts += 5
            struct_bits.append("পুলব্যাক রিকভারি")
    else:
        if st["trend"] == "DOWN":
            struct_pts += 15
            struct_bits.append("ডাউনট্রেন্ড (EMA9<EMA21)")
        elif st["trend"] == "RANGE":
            struct_pts += 10
            struct_bits.append("রেঞ্জ মার্কেট")
        else:
            struct_bits.append("আপট্রেন্ড — কাউন্টার-ট্রেন্ড ঝুঁকি")
        if st["swingTrend"] == "DOWN":
            struct_pts += 5
            struct_bits.append("LH/LL সুইং স্ট্রাকচার")
        if st["pullback"] and st["trend"] == "DOWN":
            struct_pts += 5
            struct_bits.append("পুলব্যাক রিজেকশন")
    struct_pts = min(MAX["STRUCTURE"], struct_pts)
    if struct_pts > 0:
        reasons.append({"name": "মার্কেট স্ট্রাকচার", "detail": " + ".join(struct_bits), "points": js_round(struct_pts)})

    # ---------- C. ক্যান্ডেল রিয়েকশন (max 30) ----------
    pat_pts = 0
    pat_bits = []
    clv_ok = pat["clv"] >= 0.25 if want_bull else pat["clv"] <= -0.25
    if clv_ok:
        pat_pts += 8
        sign = "+" if pat["clv"] >= 0 else ""
        pat_bits.append(f"ক্লোজ লোকেশন CLV {sign}{pat['clv']:.2f}")
    wick_ratio = pat["lowerWickPips"] if want_bull else pat["upperWickPips"]
    wick_frac = wick_ratio / (pat["rangePips"] or 1)
    if wick_frac >= 0.5:
        pat_pts += 9
        pat_bits.append(f"{'নিচের' if want_bull else 'উপরের'} উইক {wick_frac * 100:.0f}% — পিন বার রিজেকশন")
    elif wick_frac >= 0.35:
        pat_pts += 6
        pat_bits.append(f"{'নিচের' if want_bull else 'উপরের'} উইক {wick_frac * 100:.0f}%")
    if want_bull and pat["isEngulfBull"]:
        pat_pts += 8
        pat_bits.append("বুলিশ এনগালফিং")
    if not want_bull and pat["isEngulfBear"]:
        pat_pts += 8
        pat_bits.append("বেয়ারিশ এনগালফিং")
    if want_bull and pat["isMarubozu"] and pat["isBull"]:
        pat_pts += 5
        pat_bits.append("বুলিশ মারুবোজু (পূর্ণ বডি)")
    if not want_bull and pat["isMarubozu"] and pat["isBear"]:
        pat_pts += 5
        pat_bits.append("বেয়ারিশ মারুবোজু (পূর্ণ বডি)")
    late_flip_agree = (pat["lateFlip"] == 1) if want_bull else (pat["lateFlip"] == -1)
    if late_flip_agree:
        pat_pts += 6
        pat_bits.append(f"শেষ ১০ সেকেন্ডে কালার ফ্লিপ → {'গ্রিন' if want_bull else 'রেড'} (লেট মোমেন্টাম)")
    pat_pts = min(MAX["PATTERN"], pat_pts)
    if pat_pts > 0:
        reasons.append({"name": "ক্যান্ডেল রিয়েকশন", "detail": " + ".join(pat_bits), "points": js_round(pat_pts)})

    # ---------- D. টিক কনফার্মেশন (max 15) ----------
    tick_pts = 0.0
    tick_bits = []
    imb = pat["tickImbalance"] if want_bull else -pat["tickImbalance"]
    if imb >= 0.18:
        tick_pts += min(7, 4 + imb * 6)
        shown = pat["tickImbalance"] if want_bull else -pat["tickImbalance"]
        tick_bits.append(f"টিক ইমব্যালান্স {shown * 100:.0f}% {'আপ' if want_bull else 'ডাউন'}")
    mom = pat["lateMomentumPips"] if want_bull else -pat["lateMomentumPips"]
    if mom >= atr * 0.25:
        tick_pts += min(5, (mom / atr) * 3)
        tick_bits.append(f"শেষ ১০ সে. মোমেন্টাম {mom:.1f} পিপ")
    avg_ticks = 60  # typical live ticks per candle
    if c.get("ticks", 0) >= avg_ticks * 1.3:
        tick_pts += 3
        tick_bits.append("টিক অ্যাক্টিভিটি বেড়ে গেছে")
    tick_pts = min(MAX["TICK"], js_round(tick_pts))
    if tick_pts > 0:
        reasons.append({"name": "টিক কনফার্মেশন", "detail": " + ".join(tick_bits), "points": js_round(tick_pts)})

    # ---------- veto conditions ----------
    veto = None
    if swept:
        veto = "জোন ভেদ করে ক্লোজ — রিয়েকশন বাতিল"
    if veto is None and zone_pts == 0:
        veto = "কোনো লেভেল/জোন রিয়েকশন নেই"
    if veto is None and want_bull and st["trend"] == "DOWN" and zone_pts < 20:
        veto = "শক্ত ডাউনট্রেন্ডে কল সিগন্যাল ঝুঁকিপূর্ণ"
    if veto is None and (not want_bull) and st["trend"] == "UP" and zone_pts < 20:
        veto = "শক্ত আপট্রেন্ডে পুট সিগন্যাল ঝুঁকিপূর্ণ"
    if veto is None and pat["isDoji"] and zone_pts < 20:
        veto = "দোজি ক্যান্ডেল — সিদ্ধান্তহীন"

    score = zone_pts + struct_pts + pat_pts + tick_pts
    return {"score": score, "reasons": reasons, "veto": veto}


def preview_running_score(closed_candles, pseudo_candle, pdef):
    arr = list(closed_candles) + [pseudo_candle]
    return evaluate_signal(arr, len(arr) - 1, pdef)
