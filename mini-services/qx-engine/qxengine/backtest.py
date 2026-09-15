"""Walk-forward backtest — exact port of the TS backtest.ts.

Replays history through the EXACT same evaluate_signal() used for live
signals — no look-ahead: at step i only candles[0..i] are visible.
A signal at close of candle i predicts candle i+1 (1-minute binary).
"""

import time

from .types import MINUTE, DAY, js_round
from .signal_engine import evaluate_signal


def backtest_pair(pair: str, candles, pdef: dict, min_confidence: int):
    signals = []
    hour_agg = {}

    for i in range(25, len(candles) - 1):
        ev = evaluate_signal(candles, i, pdef)
        if not ev or ev["score"] < min_confidence:
            continue

        entry = candles[i]["close"]
        nxt = candles[i + 1]
        close = nxt["close"]
        if close == entry:
            result = "TIE"
        elif ev["direction"] == "CALL":
            result = "WIN" if close > entry else "LOSS"
        else:
            result = "WIN" if close < entry else "LOSS"

        ts = candles[i]["ts"] + MINUTE  # trade entry at the NEXT minute open
        signals.append({
            "pair": pair, "ts": ts, "direction": ev["direction"], "score": ev["score"],
            "reasons": ev["reasons"], "entryPrice": entry, "closePrice": close,
            "result": result,
        })

        hour = ((ts % DAY) // 3_600_000)
        agg = hour_agg.setdefault(hour, {"s": 0, "w": 0})
        agg["s"] += 1
        if result == "WIN":
            agg["w"] += 1

    wins = sum(1 for s in signals if s["result"] == "WIN")
    losses = sum(1 for s in signals if s["result"] == "LOSS")
    ties = sum(1 for s in signals if s["result"] == "TIE")
    call_s = [s for s in signals if s["direction"] == "CALL"]
    put_s = [s for s in signals if s["direction"] == "PUT"]

    max_win_streak = max_loss_streak = cur_win = cur_loss = 0
    for s in signals:
        if s["result"] == "WIN":
            cur_win += 1
            cur_loss = 0
        elif s["result"] == "LOSS":
            cur_loss += 1
            cur_win = 0
        else:
            cur_win = 0
            cur_loss = 0
        max_win_streak = max(max_win_streak, cur_win)
        max_loss_streak = max(max_loss_streak, cur_loss)

    best_hour = None
    for hour in sorted(hour_agg):
        agg = hour_agg[hour]
        if agg["s"] >= 5:
            wr = (agg["w"] / agg["s"]) * 100
            if best_hour is None or wr > best_hour["winRate"]:
                best_hour = {"hour": hour, "winRate": js_round(wr), "signals": agg["s"]}

    result = {
        "pair": pair,
        "signals": len(signals),
        "wins": wins,
        "losses": losses,
        "ties": ties,
        "winRate": js_round((wins / len(signals)) * 100) if signals else 0,
        "callSignals": len(call_s),
        "callWins": sum(1 for s in call_s if s["result"] == "WIN"),
        "putSignals": len(put_s),
        "putWins": sum(1 for s in put_s if s["result"] == "WIN"),
        "avgScore": js_round(sum(s["score"] for s in signals) / len(signals)) if signals else 0,
        "bestHour": best_hour,
        "maxWinStreak": max_win_streak,
        "maxLossStreak": max_loss_streak,
    }
    return signals, result


def aggregate_backtest(bt_id, min_confidence, per_pair, signals, candles_tested, from_ts, to_ts):
    wins = sum(p["wins"] for p in per_pair)
    losses = sum(p["losses"] for p in per_pair)
    ties = sum(p["ties"] for p in per_pair)
    total = sum(p["signals"] for p in per_pair)

    hour_map = {}
    for s in signals:
        h = (s["ts"] % DAY) // 3_600_000
        agg = hour_map.setdefault(h, {"s": 0, "w": 0})
        agg["s"] += 1
        if s["result"] == "WIN":
            agg["w"] += 1

    return {
        "id": bt_id,
        "ranAt": int(time.time() * 1000),
        "candlesTested": candles_tested,
        "from": from_ts,
        "to": to_ts,
        "minConfidence": min_confidence,
        "overall": {
            "signals": total, "wins": wins, "losses": losses, "ties": ties,
            "winRate": js_round((wins / total) * 100) if total else 0,
        },
        "perPair": per_pair,
        "perHour": [
            {"hour": h, "signals": hour_map[h]["s"],
             "winRate": js_round((hour_map[h]["w"] / hour_map[h]["s"]) * 100) if hour_map[h]["s"] else 0}
            for h in sorted(hour_map)
        ],
    }
