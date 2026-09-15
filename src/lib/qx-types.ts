// ============ QX Engine — Shared Types ============
// (moved from mini-services — the engine is Python now; the browser contract
//  stays identical: socket.io path /engine + the same events)

export interface PairDef {
  symbol: string;
  name: string;
  digits: number;
  pip: number;
  basePrice: number;
  volPips: number;
}

export type FeedSource = 'LIVE';
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

export type TrendDir = 'UP' | 'DOWN' | 'RANGE';

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
  desiredMode: string;
  /** quotex = লাইভ টোকেন টিক ফিড | market = রিয়েল মার্কেট ফিড (টোকেন ছাড়া) | none */
  feedProvider?: 'quotex' | 'market' | 'none';
  /** none | idle | pending | ok | rejected */
  qxAuthState?: string;
  liveConnected: boolean;
  /** demo | real — Quotex-এর দুই ফিডের দাম আলাদা, কোনটা চলছে */
  accountMode?: 'demo' | 'real';
  isDemo?: number;
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
  source?: string[];
  limit?: number;
}

// -------- Backtest --------

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
