'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { Candle, PairStat, SignalRec, StatsBlock } from '@/lib/qx-types';
import { useEngine } from './engine-provider';
import { DirectionBadge, EmptyState, ResultBadge, SectionTitle, fmtTime } from './bits';
import { RunningCandlePanel } from './running-candle-panel';

const CandleChart = dynamic(() => import('./candle-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[380px] w-full rounded-md border border-zinc-800 bg-zinc-900/60" />,
});

const PERIOD_CHIPS: { label: string; h: number }[] = [
  { label: 'সব', h: 0 },
  { label: '১ ঘণ্টা', h: 1 },
  { label: '৬ ঘণ্টা', h: 6 },
  { label: '২৪ ঘণ্টা', h: 24 },
];

const DIR_CHIPS: { label: string; v: 'ALL' | 'CALL' | 'PUT' }[] = [
  { label: 'সব', v: 'ALL' },
  { label: '▲ কল', v: 'CALL' },
  { label: '▼ পুট', v: 'PUT' },
];

interface StatsResp { overall: StatsBlock | null; perPair: PairStat[] }

export function SignalsTab() {
  const { market, rpc, signalTick, candleTick, connected, settings } = useEngine();
  const [pair, setPair] = useState<string>('');
  const [periodH, setPeriodH] = useState<number>(0);
  const [dir, setDir] = useState<'ALL' | 'CALL' | 'PUT'>('ALL');
  const [history, setHistory] = useState<Candle[]>([]);
  const [signals, setSignals] = useState<SignalRec[]>([]);
  const [pairSignals, setPairSignals] = useState<SignalRec[]>([]);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // derived default pair (no effect needed): first active pair until user picks one
  const activePair = pair || market?.pairs?.[0]?.pair || '';
  const digits = useMemo(() => market?.pairs.find((p) => p.pair === activePair)?.digits ?? 5, [market, activePair]);

  // chart history
  const loadHistory = useCallback(async () => {
    if (!activePair) return;
    try {
      const r = await rpc<{ candles: Candle[] }>('get-history', { pair: activePair, limit: 200 });
      setHistory(r.candles);
    } catch { /* noop */ }
  }, [activePair, rpc]);

  useEffect(() => {
    if (!connected || !activePair) return;
    void loadHistory();
  }, [connected, activePair, loadHistory]);

  useEffect(() => {
    if (candleTick && (candleTick.pair === activePair || activePair === '')) void loadHistory();
  }, [candleTick, activePair, loadHistory]);

  // signals + stats (respect filters)
  const loadSignals = useCallback(async () => {
    if (!connected) return;
    rpc<{ signals: SignalRec[] }>('get-signals', { pair: activePair, direction: dir, periodH, limit: 150 })
      .then((r) => setSignals(r.signals))
      .catch(() => {});
    rpc<StatsResp>('get-stats', { periodH })
      .then(setStats)
      .catch(() => {});
    if (activePair) {
      rpc<{ signals: SignalRec[] }>('get-signals', { pair: activePair, direction: 'ALL', periodH: 0, limit: 200 })
        .then((r) => setPairSignals(r.signals))
        .catch(() => {});
    }
  }, [connected, activePair, dir, periodH, rpc]);

  useEffect(() => {
    void loadSignals();
    const iv = setInterval(() => void loadSignals(), 6000);
    return () => clearInterval(iv);
  }, [loadSignals]);

  useEffect(() => {
    if (signalTick > 0) void loadSignals();
  }, [signalTick, loadSignals]);

  // merge running candle into chart data (1s live updates)
  const chartCandles = useMemo(() => {
    if (!history.length) return [];
    const run = market?.pairs.find((p) => p.pair === activePair)?.running;
    const base = [...history];
    const last = base[base.length - 1];
    if (run && run.ts === last.ts) {
      base[base.length - 1] = { ...last, open: run.open, high: run.high, low: run.low, close: run.last };
    } else if (run && run.ts > last.ts) {
      base.push({ ...last, ts: run.ts, open: run.open, high: run.high, low: run.low, close: run.last });
    }
    return base;
  }, [history, market, activePair]);

  const runState = market?.pairs.find((p) => p.pair === activePair)?.running ?? null;
  const pairStat = stats?.perPair.find((s) => s.pair === activePair) ?? null;
  const summary = activePair ? pairStat : stats?.overall ?? null;

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const chipCls = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400' : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
    }`;

  return (
    <div className="space-y-5">
      {/* pair selector */}
      <div className="flex flex-wrap items-center gap-2">
        {(market?.pairs ?? []).map((p) => (
          <button key={p.pair} onClick={() => setPair(p.pair)} className={chipCls(p.pair === activePair)}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* chart */}
        <div className="space-y-4 xl:col-span-2">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-semibold text-zinc-100">{activePair}</h3>
                  {runState && (
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        runState.color === 'GREEN' ? 'bg-emerald-500/15 text-emerald-400' : runState.color === 'RED' ? 'bg-red-500/15 text-red-400' : 'bg-zinc-700/40 text-zinc-300'
                      }`}
                    >
                      {runState.color === 'GREEN' ? 'গ্রিন' : runState.color === 'RED' ? 'রেড' : 'ফ্ল্যাট'}
                    </span>
                  )}
                </div>
                {runState && (
                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    <span>ক্যান্ডেল ক্লোজ হতে আর</span>
                    <span className="font-mono text-base font-bold tabular-nums text-amber-400">{runState.secondsLeft}s</span>
                  </div>
                )}
              </div>
              {chartCandles.length > 0 ? (
                <CandleChart candles={chartCandles} signals={pairSignals} digits={digits} />
              ) : (
                <EmptyState text="চার্ট লোড হচ্ছে..." />
              )}
              <p className="mt-2 text-[11px] text-zinc-500">
                মার্কার: ▲/▼ = কল/পুট সিগন্যাল (এন্ট্রি ক্যান্ডেলে) — সবুজ ✓ = উইন, লাল ✕ = লস, হলুদ = চলছে
              </p>
            </CardContent>
          </Card>

          {/* running candle analyzer */}
          <RunningCandlePanel run={runState} digits={digits} />
        </div>

        {/* right column: filters + stats + history */}
        <div className="space-y-4">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-xs font-medium text-zinc-500">সময়:</span>
                {PERIOD_CHIPS.map((p) => (
                  <button key={p.h} onClick={() => setPeriodH(p.h)} className={chipCls(periodH === p.h)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-xs font-medium text-zinc-500">দিক:</span>
                {DIR_CHIPS.map((d) => (
                  <button
                    key={d.v}
                    onClick={() => setDir(d.v)}
                    className={
                      d.v !== 'ALL'
                        ? `rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                            dir === d.v
                              ? d.v === 'CALL'
                                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400'
                                : 'border-red-500/50 bg-red-500/15 text-red-400'
                              : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
                          }`
                        : chipCls(dir === 'ALL')
                    }
                  >
                    {d.label}
                  </button>
                ))}
              </div>

              {/* summary for current filter */}
              {summary && (
                <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-zinc-800/50 px-2.5 py-2">
                    <p className="text-zinc-500">{activePair ? `${activePair} — ` : ''}মোট সিগন্যাল</p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-zinc-100">{summary.total}</p>
                  </div>
                  <div className="rounded bg-zinc-800/50 px-2.5 py-2">
                    <p className="text-zinc-500">উইন রেট</p>
                    <p className={`mt-0.5 text-lg font-bold tabular-nums ${summary.winRate >= 60 ? 'text-emerald-400' : summary.winRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                      {summary.winRate}%
                    </p>
                  </div>
                  <div className="rounded bg-emerald-500/10 px-2.5 py-2 text-emerald-400">
                    <p>কল উইন রেট: <b className="tabular-nums">{summary.call.winRate}%</b></p>
                    <p className="text-[10px] text-emerald-500/70">{summary.call.wins}W / {summary.call.losses}L</p>
                  </div>
                  <div className="rounded bg-red-500/10 px-2.5 py-2 text-red-400">
                    <p>পুট উইন রেট: <b className="tabular-nums">{summary.put.winRate}%</b></p>
                    <p className="text-[10px] text-red-500/70">{summary.put.wins}W / {summary.put.losses}L</p>
                  </div>
                  <div className="col-span-2 flex justify-between rounded bg-zinc-800/50 px-2.5 py-2 text-zinc-300">
                    <span className="text-zinc-500">স্ট্রিক: {summary.streak.maxWin}W / {summary.streak.maxLoss}L (সর্বোচ্চ)</span>
                    <span>
                      বর্তমান:{' '}
                      {summary.streak.currentType === 'W' ? (
                        <b className="text-emerald-400">{summary.streak.current} উইন</b>
                      ) : summary.streak.currentType === 'L' ? (
                        <b className="text-red-400">{summary.streak.current} লস</b>
                      ) : (
                        '—'
                      )}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* signal history */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <SectionTitle>সিগন্যাল হিস্ট্রি {activePair ? `— ${activePair}` : ''}</SectionTitle>
              </div>
              {signals.length === 0 && <EmptyState text="এই ফিল্টারে কোনো সিগন্যাল নেই" />}
              <ScrollArea className="max-h-[560px] pr-2">
                <div className="space-y-1.5">
                  {signals.map((s) => (
                    <div key={s.id} className="rounded-lg border border-zinc-800/80 bg-zinc-800/30 px-3 py-2 transition-colors hover:border-zinc-700">
                      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => toggleExpand(s.id)}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 font-mono text-xs text-zinc-500">{fmtTime(s.ts)}</span>
                          <span className="shrink-0 text-sm font-semibold text-zinc-200">{s.pair}</span>
                          <DirectionBadge d={s.direction} />
                          <span className="hidden shrink-0 text-[10px] text-zinc-600 sm:inline">{s.source === 'BACKTEST' ? 'বিটি' : ''}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs tabular-nums text-zinc-400">{s.confidence}%</span>
                          <ResultBadge r={s.result} />
                        </div>
                      </button>
                      {expanded.has(s.id) && (
                        <div className="mt-2 space-y-1.5 border-t border-zinc-800 pt-2">
                          <p className="font-mono text-[11px] text-zinc-500">
                            এন্ট্রি {s.entryPrice} → ক্লোজ {s.closePrice ?? '—'} | {new Date(s.ts).toLocaleDateString('en-GB')}
                          </p>
                          <ul className="space-y-1">
                            {s.reasons.map((r, i) => (
                              <li key={i} className="flex items-start justify-between gap-2 text-[11px] leading-snug text-zinc-400">
                                <span>
                                  <span className="text-zinc-200">{r.name}:</span> {r.detail}
                                </span>
                                <span className="shrink-0 font-mono text-zinc-500">+{r.points}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
