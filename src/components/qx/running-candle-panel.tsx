'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import type { RunningCandleState } from '../../../mini-services/qx-engine/src/types';
import { EmptyState, fmtNum } from './bits';

// ============ রানিং ক্যান্ডেল অ্যানালাইজার ============
// মানুষ চোখে যা দেখে, ইঞ্জিন মিলিসেকেন্ডে টিক-ভিত্তিক দেখে:
// টিক ইমব্যালেন্স, ৫s/১০s মোমেন্টাম, কালার-ফ্লিপ ইতিহাস,
// উইক গঠন, জোন-দূরত্ব এবং "এখন ক্লোজ হলে" লাইভ স্কোর।

function ColorDot({ color }: { color: string }) {
  const c = color === 'GREEN' ? 'bg-emerald-500' : color === 'RED' ? 'bg-red-500' : 'bg-zinc-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${c} ${color !== 'FLAT' ? 'animate-pulse' : ''}`} />;
}

export function RunningCandlePanel({ run, digits }: { run: RunningCandleState | null; digits: number }) {
  if (!run) return <EmptyState text="ক্যান্ডেল ডেটা আসছে..." />;

  const total = Math.max(run.upTicks + run.downTicks, 1);
  const upPct = Math.round((run.upTicks / total) * 100);
  const score = run.liveScore;
  const scoreOk = score && score.score >= 55;

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <ColorDot color={run.color} />
            রানিং ক্যান্ডেলের ভিতরে এখন কী হচ্ছে
          </span>
          <span className="tabular-nums text-amber-400">{run.secondsLeft}s বাকি</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* countdown */}
        <Progress className="h-1" value={((60 - run.secondsLeft) / 60) * 100} />

        {/* prices */}
        <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
          {[
            { l: 'ওপেন', v: fmtNum(run.open, digits) },
            { l: 'হাই', v: fmtNum(run.high, digits) },
            { l: 'লো', v: fmtNum(run.low, digits) },
            { l: 'লাস্ট', v: fmtNum(run.last, digits) },
          ].map((x) => (
            <div key={x.l} className="rounded bg-zinc-800/60 px-1 py-1.5">
              <p className="text-[10px] text-zinc-500">{x.l}</p>
              <p className="font-mono font-medium tabular-nums text-zinc-200">{x.v}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded bg-zinc-800/40 px-2 py-1.5">
            <span className="text-zinc-500">রঙ: </span>
            <span className={run.color === 'GREEN' ? 'font-semibold text-emerald-400' : run.color === 'RED' ? 'font-semibold text-red-400' : 'text-zinc-300'}>
              {run.color === 'GREEN' ? 'গ্রিন' : run.color === 'RED' ? 'রেড' : 'ফ্ল্যাট'}
            </span>
            <span className="ml-2 text-zinc-500">ফ্লিপ: {run.colorFlips}×</span>
          </div>
          <div className="rounded bg-zinc-800/40 px-2 py-1.5">
            <span className="text-zinc-500">শেষ ফ্লিপ: </span>
            <span className="text-zinc-200">{run.lastFlipAtSec >= 0 ? `${run.lastFlipAtSec} সেকেন্ডে` : 'নেই'}</span>
          </div>
        </div>

        {/* tick ratio */}
        <div>
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-zinc-500">টিক ডিরেকশন ({run.ticks} টিক)</span>
            <span className="tabular-nums text-zinc-300">
              <span className="text-emerald-400">{upPct}% আপ</span> / <span className="text-red-400">{100 - upPct}% ডাউন</span>
            </span>
          </div>
          <div className="flex h-2 overflow-hidden rounded bg-zinc-800">
            <div className="bg-emerald-500" style={{ width: `${upPct}%` }} />
            <div className="bg-red-500" style={{ width: `${100 - upPct}%` }} />
          </div>
        </div>

        {/* momentum + wicks */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className={`rounded px-2 py-1.5 ${run.momentum5s >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            মোমেন্টাম ৫s: <span className="font-mono tabular-nums">{run.momentum5s >= 0 ? '+' : ''}{run.momentum5s} পিপ</span>
          </div>
          <div className={`rounded px-2 py-1.5 ${run.momentum10s >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            মোমেন্টাম ১০s: <span className="font-mono tabular-nums">{run.momentum10s >= 0 ? '+' : ''}{run.momentum10s} পিপ</span>
          </div>
          <div className="rounded bg-zinc-800/40 px-2 py-1.5 text-zinc-300">
            উপরের উইক: <span className="font-mono tabular-nums">{run.upperWickPips} পিপ</span>
          </div>
          <div className="rounded bg-zinc-800/40 px-2 py-1.5 text-zinc-300">
            নিচের উইক: <span className="font-mono tabular-nums">{run.lowerWickPips} পিপ</span>
          </div>
        </div>

        {/* zone */}
        <div className="rounded bg-zinc-800/40 px-2 py-1.5 text-xs">
          {run.nearZone ? (
            <span className="text-zinc-300">
              <span className="text-zinc-500">নিকটতম জোন: </span>
              <span className={run.nearZone.side === 'SUPPORT' ? 'text-emerald-400' : 'text-red-400'}>
                {run.nearZone.side === 'SUPPORT' ? 'সাপোর্ট' : 'রেজিস্ট্যান্স'}
              </span>{' '}
              <span className="font-mono">{fmtNum(run.nearZone.price, digits)}</span>
              <span className="ml-1 text-zinc-500">
                ({run.nearZone.distancePips >= 0 ? '+' : ''}{run.nearZone.distancePips} পিপ, শক্তি {run.nearZone.strength})
              </span>
            </span>
          ) : (
            <span className="text-zinc-500">কোনো নিকট জোন নেই (৩০ পিপের মধ্যে)</span>
          )}
        </div>

        <Separator className="bg-zinc-800" />

        {/* live score preview */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-zinc-500">এখন ক্লোজ হলে ইঞ্জিনের মত:</span>
            {score && (
              <span className="flex items-center gap-1.5">
                <span className={`font-semibold ${score.direction === 'CALL' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {score.direction === 'CALL' ? '▲ কল' : '▼ পুট'}
                </span>
                <span className="tabular-nums text-zinc-300">{score.score}%</span>
              </span>
            )}
          </div>
          {score ? (
            <>
              <Progress className="h-1.5" value={score.score} />
              <ul className="mt-2 space-y-1">
                {score.reasons.map((r, i) => (
                  <li key={i} className="flex items-start justify-between gap-2 text-[11px] leading-snug">
                    <span className="text-zinc-400">
                      <span className="text-zinc-200">{r.name}:</span> {r.detail}
                    </span>
                    <span className="shrink-0 font-mono text-zinc-500">+{r.points}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-zinc-500">এখনো যথেষ্ট কনফার্মেশন জমেনি — ক্যান্ডেল ফুল ক্লোজে ফাইনাল সিদ্ধান্ত হবে।</p>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
            ⏱ এটি লাইভ প্রিভিউ — আসল সিগন্যাল শুধু ক্যান্ডেল <b>ফুল ক্লোজ</b> হলে (০০ সেকেন্ডে) তৈরি হয়।
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
