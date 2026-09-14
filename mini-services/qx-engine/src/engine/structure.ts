import type { Candle, StructureInfo, TrendDir } from '../types';

// ============ Market Structure Analysis ============
// EMA(9/21) trend + swing (HH/HL vs LH/LL) structure + pullback detection.
// This is the "মার্কেট স্ট্রাকচার" pillar of the confluence model.

function ema(values: number[], period: number): number {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function analyzeStructure(candles: readonly Candle[], pip: number): StructureInfo {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes.slice(-40), 9);
  const emaSlow = ema(closes.slice(-60), 21);

  // swings over last ~80 candles
  const look = Math.min(n - 2, 80);
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = Math.max(2, n - look); i < n - 2; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= 2; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isLow = false;
    }
    if (isHigh) swingHighs.push(c.high);
    if (isLow) swingLows.push(c.low);
  }
  let swingTrend: TrendDir = 'RANGE';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
    const hl = swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];
    const lh = swingHighs[swingHighs.length - 1] < swingHighs[swingHighs.length - 2];
    const ll = swingLows[swingLows.length - 1] < swingLows[swingLows.length - 2];
    if (hh && hl) swingTrend = 'UP';
    else if (lh && ll) swingTrend = 'DOWN';
  }

  const last = candles[n - 1];
  const emaGapPips = (emaFast - emaSlow) / pip;
  let trend: TrendDir = 'RANGE';
  if (emaGapPips > 1.2) trend = 'UP';
  else if (emaGapPips < -1.2) trend = 'DOWN';

  // strength: agreement of ema trend, swing trend, price vs ema
  let strength = 30;
  if (trend !== 'RANGE') strength += 25;
  if (swingTrend === trend && trend !== 'RANGE') strength += 25;
  const aboveFast = last.close > emaFast;
  if ((trend === 'UP' && aboveFast) || (trend === 'DOWN' && !aboveFast)) strength += 20;

  // pullback: within last 4 candles price dipped into ema zone then recovered (for UP)
  const last4 = candles.slice(-4);
  let pullback = false;
  if (trend === 'UP') {
    const dipped = last4.some((c) => c.low <= emaSlow + 2 * pip || c.low <= emaFast);
    pullback = dipped && last.close > emaFast && last.close > last.open;
  } else if (trend === 'DOWN') {
    const spiked = last4.some((c) => c.high >= emaSlow - 2 * pip || c.high >= emaFast);
    pullback = spiked && last.close < emaFast && last.close < last.open;
  }

  // consecutive candles
  let consecutiveBull = 0, consecutiveBear = 0;
  for (let i = n - 1; i >= Math.max(0, n - 10); i--) {
    if (candles[i].close > candles[i].open) consecutiveBull++;
    else break;
  }
  for (let i = n - 1; i >= Math.max(0, n - 10); i--) {
    if (candles[i].close < candles[i].open) consecutiveBear++;
    else break;
  }

  return {
    trend,
    emaFast,
    emaSlow,
    swingTrend,
    strength: Math.min(100, strength),
    atrPips: 0, // filled by caller
    consecutiveBull,
    consecutiveBear,
    pullback,
  };
}
