// ============ QX Engine — Shared Types ============

export interface PairDef {
  symbol: string;
  name: string; // display name
  digits: number; // price decimals
  pip: number; // pip size (0.0001 / 0.01)
  basePrice: number; // simulator starting price
  volPips: number; // simulator: pips stdev per minute
}

export type FeedSource = 'LIVE' | 'SIM';
export type Direction = 'CALL' | 'PUT';
export type SignalResult = 'PENDING' | 'WIN' | 'LOSS' | 'TIE';
export type CandleColor = 'GREEN' | 'RED' | 'FLAT';

export interface Tick {
  t: number; // ms epoch
  price: number;
}

export interface Candle {
  pair: string;
  ts: number; // open time ms (minute aligned)
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  upTicks: number;
  downTicks: number;
  lateFlip: number; // 1 = flipped to GREEN in final 10s, -1 = to RED, 0 = none
  lateMomentum: number; // signed pips in final 10s
  flipCount: number; // total color changes inside candle
  source: FeedSource;
}

export interface Reason {
  name: string;
  detail: string; // Bengali explanation
  points: number;
}

export interface SignalEvaluation {
  direction: Direction;
  score: number; // 0..100
  reasons: Reason[];
}

export interface SignalRec {
  id: string;
  pair: string;
  ts: number; // signal time == trade entry moment (candle close)
  direction: Direction;
  confidence: number;
  score: number;
  reasons: Reason[];
  entryPrice: number;
  closePrice: number | null;
  result: SignalResult;
  source: FeedSource | 'BACKTEST';
}

export interface Zone {
  price: number;
  side: 'SUPPORT' | 'RESISTANCE';
  strength: number; // touches
  kind: 'swing' | 'round';
}

export interface ZoneTest {
  zone: Zone;
  touched: boolean; // candle wicked into zone
  swept: boolean; // candle closed through beyond zone (invalidation)
  distancePips: number; // from candle extreme to zone price
}

export type TrendDir = 'UP' | 'DOWN' | 'RANGE';

export interface StructureInfo {
  trend: TrendDir;
  emaFast: number;
  emaSlow: number;
  swingTrend: TrendDir;
  strength: number; // 0..100
  atrPips: number;
  consecutiveBull: number;
  consecutiveBear: number;
  pullback: boolean; // recent dip to EMA zone and recovery
}

export interface CandlePattern {
  bodyPips: number;
  rangePips: number;
  upperWickPips: number;
  lowerWickPips: number;
  bodyRatio: number; // body / range (0..1)
  clv: number; // close location value -1..+1
  isBull: boolean;
  isBear: boolean;
  isPinBull: boolean;
  isPinBear: boolean;
  isEngulfBull: boolean;
  isEngulfBear: boolean;
  isDoji: boolean;
  isMarubozu: boolean;
  tickImbalance: number; // (up - down) / ticks  -1..+1
  lateFlip: number;
  lateMomentumPips: number;
}

// -------- Live runtime states --------

export interface NearZoneInfo {
  side: 'SUPPORT' | 'RESISTANCE';
  price: number;
  distancePips: number;
  strength: number;
}

export interface LiveScorePreview {
  direction: Direction;
  score: number;
  reasons: Reason[];
}

export interface RunningCandleState {
  pair: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  last: number;
  secondsLeft: number;
  color: CandleColor;
  ticks: number;
  upTicks: number;
  downTicks: number;
  tickImbalance: number;
  momentum5s: number; // pips (signed)
  momentum10s: number; // pips (signed)
  colorFlips: number;
  lastFlipAtSec: number; // -1 = none
  upperWickPips: number;
  lowerWickPips: number;
  nearZone: NearZoneInfo | null;
  liveScore: LiveScorePreview | null;
}

export interface PairMarketState {
  pair: string;
  name: string;
  digits: number;
  price: number;
  changePips1m: number; // last closed candle change
  running: RunningCandleState;
  lastClosed: Candle | null;
}

export interface EngineStatus {
  mode: FeedSource | 'CONNECTING';
  desiredMode: 'auto' | 'live' | 'simulation';
  liveConnected: boolean;
  socketClients: number;
  serverTime: number;
  accountBalance: number | null;
  currency: string | null;
  login: string | null;
  activePairs: string[];
  minConfidence: number;
  uptimeSec: number;
  historyMinutes: number;
}

export interface MarketSnapshot {
  status: EngineStatus;
  pairs: PairMarketState[];
  pendingSignals: SignalRec[];
}

export interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error' | 'raw';
  msg: string;
}

// -------- Stats --------

export interface DirStat {
  total: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number; // %
}

export interface StatsBlock {
  total: number;
  wins: number;
  losses: number;
  ties: number;
  pending: number;
  winRate: number; // %
  call: DirStat;
  put: DirStat;
  streak: { current: number; maxWin: number; maxLoss: number; currentType: 'W' | 'L' | null };
}

export interface PairStat extends StatsBlock {
  pair: string;
}

export interface SignalFilter {
  pair?: string | 'ALL';
  direction?: Direction | 'ALL';
  periodH?: number | 0; // 0 = all time
  source?: FeedSource[] | 'BACKTEST'[];
  limit?: number;
}
