import type { Candle, CandlePattern } from '../types';

// ============ Candle Pattern Analysis ============
// The "ক্যান্ডেল ফুল ক্লোজ + রিয়েকশন" pillar:
// body/wick anatomy, CLV, pin bars, engulfing, late color-flip,
// tick imbalance inside the closed candle.

export function analyzePattern(candles: readonly Candle[], i: number, pip: number): CandlePattern {
  const c = candles[i];
  const prev = i > 0 ? candles[i - 1] : null;
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  const rangePips = range / pip;
  const bodyPips = body / pip;

  // CLV: where did the candle close within its range? +1 = at high, -1 = at low
  const clv = range > 0 ? ((c.close - c.low - (c.high - c.close)) / range) : 0;

  const isBull = c.close > c.open;
  const isBear = c.close < c.open;
  const bodyRatio = range > 0 ? body / range : 0;
  const isDoji = bodyRatio <= 0.12;
  const isMarubozu = bodyRatio >= 0.85;

  const isPinBull = lowerWick / (range || 1) >= 0.5 && clv >= 0.2;
  const isPinBear = upperWick / (range || 1) >= 0.5 && clv <= -0.2;

  const isEngulfBull =
    !!prev && prev.close < prev.open && c.close > c.open && c.close >= prev.high && c.open <= prev.close;
  const isEngulfBear =
    !!prev && prev.close > prev.open && c.close < c.open && c.close <= prev.low && c.open >= prev.close;

  const tickImbalance = c.ticks > 0 ? (c.upTicks - c.downTicks) / c.ticks : 0;

  return {
    bodyPips,
    rangePips,
    upperWickPips: upperWick / pip,
    lowerWickPips: lowerWick / pip,
    bodyRatio,
    clv,
    isBull,
    isBear,
    isPinBull,
    isPinBear,
    isEngulfBull,
    isEngulfBear,
    isDoji,
    isMarubozu,
    tickImbalance,
    lateFlip: c.lateFlip,
    lateMomentumPips: c.lateMomentum,
  };
}
