'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PairStat, SignalRec, StatsBlock } from '../../../mini-services/qx-engine/src/types';
import { useEngine } from './engine-provider';
import { DirectionBadge, EmptyState, ResultBadge, WinRateCard, fmtTime, SectionTitle } from './bits';

interface StatsResp { overall: StatsBlock | null; perPair: PairStat[] }

const PERIODS: { label: string; h: number }[] = [
  { label: 'উইন রেট — শেষ ১ ঘণ্টা', h: 1 },
  { label: 'উইন রেট — শেষ ৬ ঘণ্টা', h: 6 },
  { label: 'উইন রেট — শেষ ২৪ ঘণ্টা', h: 24 },
  { label: 'উইন রেট — সর্বমোট', h: 0 },
];

export function HomeTab() {
  const { market, rpc, signalTick, connected } = useEngine();
  const [statsByPeriod, setStatsByPeriod] = useState<Record<number, StatsResp>>({});
  const [latest, setLatest] = useState<SignalRec[]>([]);

  const refresh = useCallback(async () => {
    const jobs: Promise<void>[] = [];
    for (const p of PERIODS) {
      jobs.push(
        rpc<StatsResp>('get-stats', { periodH: p.h })
          .then((r) => setStatsByPeriod((prev) => ({ ...prev, [p.h]: r })))
          .catch(() => {}),
      );
    }
    jobs.push(
      rpc<{ signals: SignalRec[] }>('get-signals', { limit: 6 })
        .then((r) => setLatest(r.signals))
        .catch(() => {}),
    );
    await Promise.all(jobs);
  }, [rpc]);

  useEffect(() => {
    if (!connected) return;
    void refresh();
    const iv = setInterval(() => void refresh(), 15000);
    return () => clearInterval(iv);
  }, [connected, refresh]);

  useEffect(() => {
    if (signalTick > 0) void refresh();
  }, [signalTick, refresh]);

  const pairs = market?.pairs ?? [];

  return (
    <div className="space-y-6">
      {/* win rate cards */}
      <section aria-label="উইন রেট সারসংক্ষেপ">
        <SectionTitle>উইন রেট সারসংক্ষেপ</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PERIODS.map((p, i) => (
            <WinRateCard key={p.h} title={p.label} block={statsByPeriod[p.h]?.overall ?? null} accent={i === 1} />
          ))}
        </div>
      </section>

      {/* live market grid */}
      <section aria-label="লাইভ মার্কেট">
        <SectionTitle>লাইভ মার্কেট (১ মিনিটের ক্যান্ডেল চলছে)</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {pairs.length === 0 && <EmptyState text="মার্কেট ডেটা আসছে..." />}
          {pairs.map((p) => {
            const up = p.changePips1m >= 0;
            return (
              <Card key={p.pair} className="border-zinc-800 bg-zinc-900/60 transition-colors hover:border-zinc-700">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-200">{p.name}</span>
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        p.running.color === 'GREEN' ? 'bg-emerald-500' : p.running.color === 'RED' ? 'bg-red-500' : 'bg-zinc-600'
                      } animate-pulse`}
                    />
                  </div>
                  <p className="mt-1 font-mono text-lg font-bold tabular-nums text-zinc-100">
                    {p.price.toFixed(p.digits)}
                  </p>
                  <div className="mt-1.5 flex items-center justify-between text-[11px]">
                    <span className={up ? 'text-emerald-400' : 'text-red-400'}>
                      {up ? '▲' : '▼'} {Math.abs(p.changePips1m)} পিপ (আগের ক্যান্ডেল)
                    </span>
                    <span className="tabular-nums text-zinc-500">{p.running.secondsLeft}s</span>
                  </div>
                  {p.running.liveScore && p.running.liveScore.score >= 55 && (
                    <p className={`mt-2 truncate rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      p.running.liveScore.direction === 'CALL' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                    }`}>
                      প্রিভিউ: {p.running.liveScore.direction === 'CALL' ? '▲ কল' : '▼ পুট'} {p.running.liveScore.score}%
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* per pair win rate */}
        <section aria-label="পেয়ার-ভিত্তিক উইন রেট">
          <SectionTitle>পেয়ার-ভিত্তিক উইন রেট (সর্বমোট)</SectionTitle>
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-0">
              <ScrollArea className="max-h-72">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-zinc-900/95 text-zinc-500">
                    <tr className="border-b border-zinc-800">
                      <th className="px-3 py-2 text-left font-medium">পেয়ার</th>
                      <th className="px-2 py-2 text-right font-medium">সিগন্যাল</th>
                      <th className="px-2 py-2 text-right font-medium">উইন রেট</th>
                      <th className="px-2 py-2 text-right font-medium">কল</th>
                      <th className="px-3 py-2 text-right font-medium">পুট</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(statsByPeriod[0]?.perPair ?? []).map((s) => (
                      <tr key={s.pair} className="border-b border-zinc-800/60 last:border-0">
                        <td className="px-3 py-2 font-medium text-zinc-200">{s.pair}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-zinc-400">{s.total}</td>
                        <td className={`px-2 py-2 text-right font-semibold tabular-nums ${s.winRate >= 60 ? 'text-emerald-400' : s.winRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                          {s.winRate}%
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-emerald-400/80">{s.call.winRate}%</td>
                        <td className="px-3 py-2 text-right tabular-nums text-red-400/80">{s.put.winRate}%</td>
                      </tr>
                    ))}
                    {!(statsByPeriod[0]?.perPair ?? []).length && (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-zinc-500">ডেটা আসছে...</td></tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>
            </CardContent>
          </Card>
        </section>

        {/* latest signals */}
        <section aria-label="সর্বশেষ সিগন্যাল">
          <SectionTitle>সর্বশেষ সিগন্যাল</SectionTitle>
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-3">
              {latest.length === 0 && <EmptyState text="এখনো কোনো সিগন্যাল নেই — ক্যান্ডেল ক্লোজে তৈরি হবে" />}
              <div className="space-y-2">
                {latest.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-md bg-zinc-800/40 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-zinc-500">{fmtTime(s.ts)}</span>
                      <span className="text-sm font-semibold text-zinc-200">{s.pair}</span>
                      <DirectionBadge d={s.direction} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs tabular-nums text-zinc-500">{s.confidence}%</span>
                      <ResultBadge r={s.result} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
