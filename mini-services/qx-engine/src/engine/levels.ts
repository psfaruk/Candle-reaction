import type { Candle, Zone } from '../types';

// ============ Support / Resistance Zone Detection ============
// Swing fractals clustered into zones + round-number levels.
// Zones are the "লেভেল/জোন" pillar of the confluence model.

export function detectZones(candles: readonly Candle[], pip: number, refPrice: number): Zone[] {
  const n = candles.length;
  if (n < 12) return [];
  const look = Math.min(n - 2, 150);
  const startIdx = n - look;

  // ATR(14) in price units
  let atrSum = 0;
  let atrCnt = 0;
  for (let i = Math.max(1, n - 14); i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atrCnt++;
  }
  const atr = atrCnt ? atrSum / atrCnt : 5 * pip;
  const tol = Math.max(atr * 0.35, 2.5 * pip);

  // swing fractals (2 each side)
  const swingHighs: { price: number; idx: number }[] = [];
  const swingLows: { price: number; idx: number }[] = [];
  for (let i = startIdx + 2; i < n - 2; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= 2; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isLow = false;
    }
    if (isHigh) swingHighs.push({ price: c.high, idx: i });
    if (isLow) swingLows.push({ price: c.low, idx: i });
  }

  const zones: Zone[] = [];
  const cluster = (points: { price: number; idx: number }[]) => {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    let group: { price: number; idx: number }[] = [];
    const flush = () => {
      if (group.length >= 2) {
        const avg = group.reduce((s, g) => s + g.price, 0) / group.length;
        const below = avg < refPrice;
        zones.push({
          price: Number(avg.toFixed(6)),
          side: below ? 'SUPPORT' : 'RESISTANCE',
          strength: group.length,
          kind: 'swing',
        });
      }
      group = [];
    };
    for (const p of sorted) {
      if (group.length && p.price - group[group.length - 1].price > tol) flush();
      group.push(p);
    }
    flush();
  };
  cluster(swingHighs);
  cluster(swingLows);

  // round-number levels (25-pip grid) around current price
  const grid = 25 * pip;
  const base = Math.round(refPrice / grid) * grid;
  for (let k = -2; k <= 2; k++) {
    if (k === 0) continue;
    const price = base + k * grid;
    if (price <= 0) continue;
    const exists = zones.some((z) => Math.abs(z.price - price) < pip * 3);
    if (!exists) {
      zones.push({
        price: Number(price.toFixed(6)),
        side: price < refPrice ? 'SUPPORT' : 'RESISTANCE',
        strength: 2,
        kind: 'round',
      });
    }
  }

  // dedupe close zones (merge strength), keep nearest 5 each side
  const merged: Zone[] = [];
  for (const z of [...zones].sort((a, b) => Math.abs(a.price - refPrice) - Math.abs(b.price - refPrice))) {
    const near = merged.find((m) => Math.abs(m.price - z.price) <= tol * 0.8);
    if (near) {
      near.strength = Math.min(9, near.strength + 1);
    } else {
      merged.push({ ...z });
    }
  }
  const sup = merged.filter((z) => z.side === 'SUPPORT').sort((a, b) => b.price - a.price).slice(0, 4);
  const res = merged.filter((z) => z.side === 'RESISTANCE').sort((a, b) => a.price - b.price).slice(0, 4);
  return [...sup, ...res];
}

export function atrPips(candles: readonly Candle[], pip: number): number {
  const n = candles.length;
  if (n < 2) return 0;
  let s = 0, c = 0;
  for (let i = Math.max(1, n - 14); i < n; i++) {
    const a = candles[i], p = candles[i - 1];
    s += Math.max(a.high - a.low, Math.abs(a.high - p.close), Math.abs(a.low - p.close));
    c++;
  }
  return (s / c) / pip;
}
