import type { Candle, CandleColor, Tick, Zone } from '../types';

// ============ Running Candle Builder ============
// Tracks EVERYTHING hidden inside a running 1-minute candle:
// per-second color path (late color-flip detection), tick imbalance,
// 5s/10s momentum, wick formation, flip count, zone proximity.

const MINUTE = 60000;

export class RunningCandle {
  pair: string;
  ts: number; // minute-aligned open time (ms)
  open: number;
  high: number;
  low: number;
  last: number;
  ticks = 0;
  upTicks = 0;
  downTicks = 0;
  lastTickAt = 0;
  secColors: CandleColor[] = new Array(60).fill('FLAT');
  flips: number[] = []; // seconds at which color changed
  recent: Tick[] = []; // last ~20s of ticks for momentum

  constructor(pair: string, ts: number, openPrice: number) {
    this.pair = pair;
    this.ts = ts;
    this.open = openPrice;
    this.high = openPrice;
    this.low = openPrice;
    this.last = openPrice;
  }

  onTick(t: Tick) {
    if (t.t < this.ts) return;
    this.lastTickAt = t.t;
    const prev = this.last;
    this.last = t.price;
    if (t.price > this.high) this.high = t.price;
    if (t.price < this.low) this.low = t.price;
    this.ticks += 1;
    if (t.price > prev) this.upTicks += 1;
    else if (t.price < prev) this.downTicks += 1;

    const sec = Math.min(59, Math.floor((t.t - this.ts) / 1000));
    const color: CandleColor = t.price > this.open ? 'GREEN' : t.price < this.open ? 'RED' : this.secColors[sec] || 'FLAT';
    const prevColor = this.secColors[sec] || 'FLAT';
    this.secColors[sec] = color;
    if (prevColor === 'FLAT' && color !== 'FLAT') {
      // first color assignment for this second — check flip vs previous colored second
      const prevColored = this.lastColorBefore(sec);
      if (prevColored && prevColored !== color) this.flips.push(sec);
    }
    // momentum buffer
    this.recent.push(t);
    const cutoff = t.t - 22000;
    while (this.recent.length && this.recent[0].t < cutoff) this.recent.shift();
  }

  private lastColorBefore(sec: number): CandleColor | null {
    for (let s = sec - 1; s >= 0; s--) {
      const c = this.secColors[s];
      if (c && c !== 'FLAT') return c;
    }
    return null;
  }

  get color(): CandleColor {
    return this.last > this.open ? 'GREEN' : this.last < this.open ? 'RED' : 'FLAT';
  }

  private colorAtSecond(sec: number): CandleColor {
    for (let s = sec; s >= 0; s--) {
      const c = this.secColors[s];
      if (c && c !== 'FLAT') return c;
    }
    return 'FLAT';
  }

  priceAt(ms: number): number | null {
    // last tick price at or before ms
    for (let i = this.recent.length - 1; i >= 0; i--) {
      if (this.recent[i].t <= ms) return this.recent[i].price;
    }
    return this.recent.length ? this.recent[0].price : null;
  }

  momentum(secBack: number, pip: number, now: number): number {
    const p = this.priceAt(now - secBack * 1000);
    if (p == null) return 0;
    return Number((((this.last - p) / pip)).toFixed(2));
  }

  /** finalize into a closed Candle at minute end */
  toCandle(source: 'LIVE' | 'SIM', now: number): Candle {
    const finalColor = this.color;
    const color50 = this.colorAtSecond(50);
    let lateFlip = 0;
    if (finalColor !== 'FLAT' && color50 !== 'FLAT' && finalColor !== color50 && (this.flips.length === 0 || this.flips[this.flips.length - 1] >= 50)) {
      lateFlip = finalColor === 'GREEN' ? 1 : -1;
    }
    const lateMom = this.momentum(10, 1, Math.min(now, this.ts + MINUTE - 1)); // pip=1 → price units
    return {
      pair: this.pair,
      ts: this.ts,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.last,
      ticks: this.ticks,
      upTicks: this.upTicks,
      downTicks: this.downTicks,
      lateFlip,
      lateMomentum: lateMom,
      flipCount: this.flips.length,
      source,
    };
  }

  /** build a pseudo-closed candle for live scoring preview (as-if-closed NOW) */
  toPseudoCandle(source: 'LIVE' | 'SIM'): Candle {
    const finalColor = this.color;
    const color50 = this.colorAtSecond(50);
    let lateFlip = 0;
    const secNow = Math.min(59, Math.floor((Date.now() - this.ts) / 1000));
    if (finalColor !== 'FLAT' && color50 !== 'FLAT' && finalColor !== color50 && secNow >= 52) {
      lateFlip = finalColor === 'GREEN' ? 1 : -1;
    }
    return {
      pair: this.pair,
      ts: this.ts,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.last,
      ticks: this.ticks,
      upTicks: this.upTicks,
      downTicks: this.downTicks,
      lateFlip,
      lateMomentum: 0,
      flipCount: this.flips.length,
      source,
    };
  }
}

// per-pair store: closed candles (RAM ring buffer) + current running candle
export class PairCandleStore {
  pair: string;
  candles: Candle[] = [];
  running: RunningCandle | null = null;
  maxKeep = 700;

  constructor(pair: string) {
    this.pair = pair;
  }

  onTick(t: Tick): 'new-candle' | 'updated' | 'ignored' {
    const minute = Math.floor(t.t / MINUTE) * MINUTE;
    if (!this.running || this.running.ts !== minute) {
      if (this.running && this.running.ts > minute) return 'ignored'; // late tick for old candle
      // note: closing is handled by the engine minute-watcher, not here;
      // here we just start the next running candle if the engine already closed the previous
      this.running = new RunningCandle(this.pair, minute, t.price);
      this.running.onTick(t);
      return 'new-candle';
    }
    this.running.onTick(t);
    return 'updated';
  }

  closeCurrent(now: number, source: 'LIVE' | 'SIM'): Candle | null {
    if (!this.running) return null;
    const candle = this.running.toCandle(source, now);
    this.candles.push(candle);
    if (this.candles.length > this.maxKeep) this.candles.splice(0, this.candles.length - this.maxKeep);
    this.running = null;
    return candle;
  }

  startRunning(ts: number, openPrice: number) {
    this.running = new RunningCandle(this.pair, ts, openPrice);
  }

  appendClosed(c: Candle) {
    this.candles.push(c);
    if (this.candles.length > this.maxKeep) this.candles.splice(0, this.candles.length - this.maxKeep);
  }
}
