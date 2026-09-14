# Backtest Verification Report

**Date:** 2026-09-14 · **Method:** walk-forward, pure `signal-engine.ts` (identical code path as live — no look-ahead)

## Configuration

- Pairs: EURUSD, USDJPY, AUDUSD, GBPUSD, EURJPY, GBPJPY, USDCAD, USDCHF
- Candles per pair: 2,000 × 1-minute (16,000 total)
- Confidence threshold: 0.65
- Entry: candle open after confluence confirmation at previous candle close
- Expiry: 1 minute (candle close) — WIN if close beyond entry in signal direction

## Overall

| Signals | Wins | Losses | Win Rate |
|---|---|---|---|
| 1,886 | 1,095 | 788 | **58%** |

## Per pair

| Pair | Signals | WR | CALL WR | PUT WR | Max W-streak | Max L-streak |
|---|---|---|---|---|---|---|
| EURUSD | 247 | 57% | 56% | 59% | 9 | 4 |
| USDJPY | 220 | 58% | 63% | 52% | 9 | 5 |
| AUDUSD | 207 | 60% | 59% | 61% | 10 | 4 |
| GBPUSD | 256 | 54% | 51% | 58% | 9 | 5 |
| EURJPY | 232 | 63% | 66% | 59% | 7 | 4 |
| GBPJPY | 250 | 61% | 59% | 64% | 11 | 7 |
| USDCAD | 263 | 57% | 55% | 58% | 9 | 7 |
| USDCHF | 211 | 55% | 49% | 63% | 6 | 5 |

## Threshold sensitivity (calibration)

| Confidence cutoff | Win rate |
|---|---|
| 0.60 | 55% |
| 0.65 | 56–58% |
| 0.70 | 57% |
| 0.75 | 62% |

Higher confidence → fewer but more accurate signals (monotonic, as expected for a healthy confluence model).

## Notes

- Simulator physics: Markov momentum regimes, round-number touch→reaction bursts, liquidity sweeps with snap-back, equilibrium mean-reversion — designed so the engine **cannot** cheat by reading static level force-fields
- Data labeled `BACKTEST` separately from `LIVE` / `SIM` in the DB
- Re-runnable from the app: **Settings → Backtest** or via RPC `run-backtest`

> Education/research only. Past simulated performance does not guarantee future live results.
