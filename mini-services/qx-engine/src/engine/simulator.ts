import type { PairDef, Tick } from '../types';

// ============ Realistic Tick Simulator ============
// Market microstructure model (mirrors real S/R behavior):
//  • Trend/range regimes (Markov chain) — drift only, NO artificial anchor
//  • Round-number levels: approach side acts as support/resistance.
//    On TOUCH (≤2.8 pips) → reaction impulse AWAY from the level
//    (order-flow burst, like real bounces).
//  • Liquidity sweeps: price pushes THROUGH a level (stop hunt),
//    then snaps back — produces pin bars + late color-flips.
//  • After the impulse/repulsion fades: pure noise + regime drift.
// Used when live Quotex connection is unavailable so the whole
// pipeline (signals, stats, backtest) stays fully verifiable.

type Regime = 'UP' | 'DOWN' | 'RANGE';

interface SimState {
  def: PairDef;
  price: number;
  regime: Regime;
  regimeLeftMin: number;
  // level interaction state
  zoneKey: number; // which round level are we interacting with
  zoneSide: number; // +1 = approaching from above (level = support), -1 = from below
  wasNear: boolean; // currently inside the level's approach band
  reactionLeft: number; // ticks of away-from-level impulse (order-flow burst)
  reactionDir: number;
  postLeft: number; // ticks of mild continuation drift after a reaction
  sweepLeft: number; // ticks of push-through (stop hunt)
  sweepDir: number;
  revertLeft: number; // ticks of snap-back after sweep
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const REGIME_DRIFT: Record<Regime, number> = { UP: 0.28, DOWN: -0.28, RANGE: 0 };

function newSimState(def: PairDef, startPrice: number): SimState {
  return {
    def,
    price: startPrice,
    regime: 'RANGE',
    regimeLeftMin: Math.floor(rnd(2, 6)),
    zoneKey: 0,
    zoneSide: 1,
    wasNear: false,
    reactionLeft: 0,
    reactionDir: 0,
    postLeft: 0,
    sweepLeft: 0,
    sweepDir: 0,
    revertLeft: 0,
  };
}

/**
 * one physics step — shared by the live loop and history generator.
 * IMPORTANT: levels exert NO static force. Force exists only in the
 * moment of a TOUCH (reaction burst) or a SWEEP (stop hunt + snap back).
 * Between events: pure noise + regime drift (zero candle autocorrelation).
 */
function physicsStep(s: SimState, perTickSigma: number, drift: number): void {
  const def = s.def;
  const pip = def.pip;
  let price = s.price;

  if (s.sweepLeft > 0) {
    // stop-hunt: aggressive push through the level
    price += s.sweepDir * perTickSigma * rnd(1.5, 2.5);
    s.sweepLeft -= 1;
    if (s.sweepLeft === 0) s.revertLeft = Math.floor(rnd(4, 9));
  } else if (s.revertLeft > 0) {
    // snap-back toward the approach side (stop-hunt reversal)
    price -= s.sweepDir * perTickSigma * rnd(1.2, 2.2);
    s.revertLeft -= 1;
    if (s.revertLeft === 0) {
      // reversal continues as a reaction impulse + continuation drift
      s.reactionLeft = Math.floor(rnd(5, 9));
      s.reactionDir = -s.sweepDir;
    }
  } else if (s.reactionLeft > 0) {
    // bounce burst away from the level (defended level → order flow)
    price += s.reactionDir * perTickSigma * rnd(0.9, 1.7);
    s.reactionLeft -= 1;
    if (s.reactionLeft === 0) s.postLeft = Math.floor(rnd(25, 60));
  } else if (s.postLeft > 0) {
    // post-reaction continuation (momentum from the bounce, ~30-90s)
    price += s.reactionDir * perTickSigma * rnd(0.25, 0.55);
    s.postLeft -= 1;
  } else {
    // idle: level interaction (touch / sweep triggers only)
    const g = 25 * pip;
    const lvl = Math.round(price / g) * g;
    const dist = price - lvl;
    const distPips = Math.abs(dist) / pip;
    if (lvl !== s.zoneKey) {
      s.zoneKey = lvl;
      s.zoneSide = Math.sign(dist) || 1;
      s.wasNear = false;
    }
    if (distPips > 4.5) s.wasNear = false; // left the approach band
    // price broke clearly to the other side → level flips role
    if (distPips > 2.8 && Math.sign(dist) !== s.zoneSide) s.zoneSide = Math.sign(dist);
    if (!s.wasNear && distPips < 2.8) {
      // fresh approach → TOUCH → reaction burst back toward the approach side
      s.wasNear = true;
      s.reactionLeft = Math.floor(rnd(6, 14));
      s.reactionDir = s.zoneSide;
    } else if (!s.wasNear && distPips < 4.5 && Math.sign(dist) === s.zoneSide && Math.random() < 0.006) {
      // fresh approach → occasional liquidity sweep through the level
      s.wasNear = true;
      s.sweepLeft = Math.floor(rnd(3, 7));
      s.sweepDir = -s.zoneSide;
    }
  }

  // base dynamics: regime drift + noise (always)
  price += drift + gauss() * perTickSigma;

  // safety bounds far outside the walk's reach (±12%): never binds in practice
  const lo = def.basePrice * 0.88;
  const hi = def.basePrice * 1.12;
  if (price < lo) price = lo + (lo - price) * 0.5;
  if (price > hi) price = hi - (price - hi) * 0.5;

  s.price = Number(price.toFixed(def.digits));
}

/**
 * Containment drift: a smooth counter-trend beyond ±1.2% from the pair's
 * base price (models fundamental pullback after overextension). Zero inside
 * the normal band, so level reactions and trend behavior stay untouched.
 */
function containmentDrift(s: SimState, vol: number): number {
  const devPct = (s.price - s.def.basePrice) / s.def.basePrice;
  const excess = Math.abs(devPct) - 0.018;
  if (excess <= 0) return 0;
  const k = Math.min(2.0, 0.35 + excess * 55);
  return -Math.sign(devPct) * k * vol; // per-minute drift magnitude
}

function evolveRegime(s: SimState) {
  s.regimeLeftMin -= 1;
  if (s.regimeLeftMin <= 0) {
    // distance-aware regime selection: far above base → favor DOWN (and vice versa).
    // Keeps the walk inside realistic FX ranges over days WITHOUT any per-tick
    // anchor force, so trend continuation and level reactions stay intact.
    const devPct = (s.price - s.def.basePrice) / s.def.basePrice;
    const bias = Math.max(-0.35, Math.min(0.35, devPct * 12));
    const r = Math.random() - bias;
    s.regime =
      s.regime === 'UP' ? (r < 0.45 ? 'RANGE' : 'DOWN')
      : s.regime === 'DOWN' ? (r < 0.45 ? 'RANGE' : 'UP')
      : r < 0.5 ? 'UP' : 'DOWN';
    // regimes fighting the reversion bias are shorter-lived
    const against = (s.regime === 'UP' && devPct > 0.015) || (s.regime === 'DOWN' && devPct < -0.015);
    s.regimeLeftMin = Math.floor(rnd(3, against ? 4 : 9));
  }
}

export class TickSimulator {
  private sims = new Map<string, SimState & { nextTickAt: number }>();
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  initPair(def: PairDef, startPrice?: number) {
    const s = newSimState(def, startPrice ?? def.basePrice);
    (s as any).nextTickAt = 0;
    this.sims.set(def.symbol, s as SimState & { nextTickAt: number });
  }

  hasPair(symbol: string) {
    return this.sims.has(symbol);
  }

  removePair(symbol: string) {
    this.sims.delete(symbol);
  }

  /** generate the next simulated tick for a pair (called by engine loop) */
  nextTick(symbol: string, now: number): Tick | null {
    const s = this.sims.get(symbol);
    if (!s) return null;
    if (now < s.nextTickAt) return null;
    s.nextTickAt = now + rnd(220, 520); // ~2.6 ticks/sec avg

    const def = s.def;
    const vol = def.volPips * def.pip; // per-minute stdev in price units
    const perTickSigma = vol / Math.sqrt(150);
    const drift = (REGIME_DRIFT[s.regime] * vol * 0.35 + containmentDrift(s, vol)) / 150;

    if (s.nextTickAt % 60000 < 600) evolveRegime(s);
    const prevRegime = s.regime;
    physicsStep(s, perTickSigma, drift);
    if (s.regime !== prevRegime && Math.random() < 0.4) this.log(`[${symbol}] sim regime → ${s.regime}`);

    return { t: now, price: s.price };
  }

  /** fast-forward history generation: `minutes` closed 1m candles ending at `endMs` (minute-aligned) */
  generateHistory(def: PairDef, minutes: number, endMs: number) {
    const s = newSimState(def, def.basePrice * rnd(0.997, 1.003));
    const vol = def.volPips * def.pip;
    const ticksPerMin = 64;
    const perTickSigma = vol / Math.sqrt(ticksPerMin);
    const startMs = endMs - minutes * 60000;

    const candles: {
      ts: number; open: number; high: number; low: number; close: number;
      ticks: number; up: number; down: number;
    }[] = [];

    const pushTick = (ts: number, price: number) => {
      let c = candles[candles.length - 1];
      if (!c || c.ts !== ts) {
        c = { ts, open: price, high: price, low: price, close: price, ticks: 0, up: 0, down: 0 };
        candles.push(c);
      }
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      const prev = c.close;
      c.close = price;
      c.ticks += 1;
      if (price > prev) c.up += 1;
      else if (price < prev) c.down += 1;
    };

    for (let m = 0; m < minutes; m++) {
      const ts = startMs + m * 60000;
      evolveRegime(s);
      const drift = (REGIME_DRIFT[s.regime] * vol * 0.35 + containmentDrift(s, vol)) / ticksPerMin;
      for (let k = 0; k < ticksPerMin; k++) {
        physicsStep(s, perTickSigma, drift);
        pushTick(ts, s.price);
      }
    }

    // finalize candle internals: reconstruct approximate per-second color path
    const out = candles.map((c) => {
      const path: number[] = [];
      const firstHalfGoToHigh = Math.random() < 0.5;
      const mid = firstHalfGoToHigh ? c.high : c.low;
      const other = firstHalfGoToHigh ? c.low : c.high;
      for (let i = 0; i <= 30; i++) path.push(c.open + ((mid - c.open) * i) / 30);
      for (let i = 0; i <= 29; i++) path.push(mid + ((other - mid) * i) / 29);
      for (let i = 0; i <= 59; i++) path.push(other + ((c.close - other) * i) / 59);

      let flips = 0;
      let lastColor: 'GREEN' | 'RED' | 'FLAT' = 'FLAT';
      const colorAt = (sec: number): 'GREEN' | 'RED' | 'FLAT' => {
        const p = path[Math.min(sec, path.length - 1)];
        if (p > c.open) return 'GREEN';
        if (p < c.open) return 'RED';
        return lastColor === 'FLAT' ? 'FLAT' : lastColor;
      };
      for (let sec = 0; sec < 60; sec++) {
        const col = colorAt(sec);
        if (sec > 0 && col !== lastColor && lastColor !== 'FLAT') flips += 1;
        lastColor = col;
      }
      const finalColor = c.close > c.open ? 'GREEN' : c.close < c.open ? 'RED' : 'FLAT';
      const color50 = colorAt(50);
      const lateFlip = finalColor !== 'FLAT' && finalColor !== color50 ? (finalColor === 'GREEN' ? 1 : -1) : 0;
      const lateMom = (c.close - path[Math.min(50, path.length - 1)]) / def.pip;
      return {
        pair: def.symbol,
        ts: c.ts,
        open: c.open, high: c.high, low: c.low, close: c.close,
        ticks: c.ticks, upTicks: c.up, downTicks: c.down,
        lateFlip,
        lateMomentum: Number(lateMom.toFixed(2)),
        flipCount: flips,
        source: 'SIM' as const,
      };
    });
    return out;
  }
}
