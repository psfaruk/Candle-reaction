import type { Candle, PairDef, Reason, SignalEvaluation } from '../types';
import { evaluateSignal } from './signal-engine';

// ============ Walk-Forward Backtest ============
// Replays history through the EXACT same evaluateSignal() used for live
// signals — no look-ahead: at step i only candles[0..i] are visible.
// A signal at close of candle i predicts candle i+1 (1-minute binary).

export interface BTSignal {
  pair: string;
  ts: number; // signal time
  direction: 'CALL' | 'PUT';
  score: number;
  reasons: Reason[];
  entryPrice: number;
  closePrice: number;
  result: 'WIN' | 'LOSS' | 'TIE';
}

export interface BTPairResult {
  pair: string;
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  callSignals: number;
  callWins: number;
  putSignals: number;
  putWins: number;
  avgScore: number;
  bestHour: { hour: number; winRate: number; signals: number } | null;
  maxWinStreak: number;
  maxLossStreak: number;
}

export interface BTSummary {
  id: string;
  ranAt: number;
  candlesTested: number;
  from: number;
  to: number;
  minConfidence: number;
  overall: { signals: number; wins: number; losses: number; ties: number; winRate: number };
  perPair: BTPairResult[];
  perHour: { hour: number; signals: number; winRate: number }[];
}

export function backtestPair(
  pair: string,
  candles: readonly Candle[],
  def: PairDef,
  minConfidence: number,
): { signals: BTSignal[]; result: BTPairResult } {
  const signals: BTSignal[] = [];
  const hourAgg = new Map<number, { s: number; w: number }>();

  for (let i = 25; i < candles.length - 1; i++) {
    const ev: SignalEvaluation | null = evaluateSignal({ candles, last: i, def });
    if (!ev || ev.score < minConfidence) continue;

    const entry = candles[i].close;
    const next = candles[i + 1];
    const close = next.close;
    let result: 'WIN' | 'LOSS' | 'TIE';
    if (close === entry) result = 'TIE';
    else if (ev.direction === 'CALL') result = close > entry ? 'WIN' : 'LOSS';
    else result = close < entry ? 'WIN' : 'LOSS';

    signals.push({
      pair,
      ts: candles[i].ts + 60000, // trade entry at the NEXT minute open
      direction: ev.direction,
      score: ev.score,
      reasons: ev.reasons,
      entryPrice: entry,
      closePrice: close,
      result,
    });

    const hour = Math.floor(((candles[i].ts + 60000) % 86400000) / 3600000);
    const agg = hourAgg.get(hour) ?? { s: 0, w: 0 };
    agg.s += 1;
    if (result === 'WIN') agg.w += 1;
    hourAgg.set(hour, agg);
  }

  const wins = signals.filter((s) => s.result === 'WIN').length;
  const losses = signals.filter((s) => s.result === 'LOSS').length;
  const ties = signals.filter((s) => s.result === 'TIE').length;
  const callS = signals.filter((s) => s.direction === 'CALL');
  const putS = signals.filter((s) => s.direction === 'PUT');

  // streaks
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const s of signals) {
    if (s.result === 'WIN') { curWin++; curLoss = 0; }
    else if (s.result === 'LOSS') { curLoss++; curWin = 0; }
    else { curWin = 0; curLoss = 0; }
    maxWinStreak = Math.max(maxWinStreak, curWin);
    maxLossStreak = Math.max(maxLossStreak, curLoss);
  }

  let bestHour: BTPairResult['bestHour'] = null;
  for (const [hour, agg] of hourAgg) {
    if (agg.s >= 5) {
      const wr = (agg.w / agg.s) * 100;
      if (!bestHour || wr > bestHour.winRate) bestHour = { hour, winRate: Math.round(wr), signals: agg.s };
    }
  }

  const result: BTPairResult = {
    pair,
    signals: signals.length,
    wins,
    losses,
    ties,
    winRate: signals.length ? Math.round((wins / signals.length) * 100) : 0,
    callSignals: callS.length,
    callWins: callS.filter((s) => s.result === 'WIN').length,
    putSignals: putS.length,
    putWins: putS.filter((s) => s.result === 'WIN').length,
    avgScore: signals.length ? Math.round(signals.reduce((a, s) => a + s.score, 0) / signals.length) : 0,
    bestHour,
    maxWinStreak,
    maxLossStreak,
  };
  return { signals, result };
}

export function aggregateBacktest(
  id: string,
  minConfidence: number,
  perPair: BTPairResult[],
  signals: BTSignal[],
  candlesTested: number,
  from: number,
  to: number,
): BTSummary {
  const wins = perPair.reduce((a, p) => a + p.wins, 0);
  const losses = perPair.reduce((a, p) => a + p.losses, 0);
  const ties = perPair.reduce((a, p) => a + p.ties, 0);
  const total = perPair.reduce((a, p) => a + p.signals, 0);

  const hourMap = new Map<number, { s: number; w: number }>();
  for (const s of signals) {
    const h = Math.floor((s.ts % 86400000) / 3600000);
    const agg = hourMap.get(h) ?? { s: 0, w: 0 };
    agg.s += 1;
    if (s.result === 'WIN') agg.w += 1;
    hourMap.set(h, agg);
  }

  return {
    id,
    ranAt: Date.now(),
    candlesTested,
    from,
    to,
    minConfidence,
    overall: {
      signals: total,
      wins,
      losses,
      ties,
      winRate: total ? Math.round((wins / total) * 100) : 0,
    },
    perPair,
    perHour: [...hourMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, agg]) => ({ hour, signals: agg.s, winRate: agg.s ? Math.round((agg.w / agg.s) * 100) : 0 })),
  };
}
