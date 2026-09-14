'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { Direction, SignalResult, StatsBlock } from '../../../mini-services/qx-engine/src/types';

export function DirectionBadge({ d, size = 'sm' }: { d: Direction; size?: 'sm' | 'lg' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-semibold tracking-wide ${
        size === 'lg' ? 'px-2.5 py-1 text-sm' : 'px-1.5 py-0.5 text-xs'
      } ${d === 'CALL' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}
    >
      {d === 'CALL' ? '▲ কল' : '▼ পুট'}
    </span>
  );
}

export function ResultBadge({ r }: { r: SignalResult }) {
  const map: Record<SignalResult, { cls: string; label: string }> = {
    WIN: { cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', label: 'উইন' },
    LOSS: { cls: 'bg-red-500/15 text-red-400 border-red-500/30', label: 'লস' },
    TIE: { cls: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30', label: 'টাই' },
    PENDING: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30', label: 'চলছে' },
  };
  const m = map[r];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-semibold ${m.cls}`}>
      {r === 'PENDING' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />}
      {m.label}
    </span>
  );
}

export function WinRateCard({ title, block, accent }: { title: string; block: StatsBlock | null; accent?: boolean }) {
  const wr = block?.winRate ?? 0;
  const decided = (block?.wins ?? 0) + (block?.losses ?? 0);
  const good = wr >= 60;
  const mid = wr >= 50;
  return (
    <Card className={`border-zinc-800 bg-zinc-900/60 ${accent ? 'ring-1 ring-emerald-500/20' : ''}`}>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-medium text-zinc-400">{title}</p>
          <p className="text-xs text-zinc-500">
            {block ? `${decided} ট্রেড` : '—'}
          </p>
        </div>
        <div className="mt-2 flex items-end gap-2">
          <p className={`text-3xl font-bold tabular-nums ${good ? 'text-emerald-400' : mid ? 'text-amber-400' : 'text-red-400'}`}>
            {block ? `${wr}%` : '—'}
          </p>
          {block && (
            <p className="pb-1 text-xs text-zinc-500">
              <span className="text-emerald-500">{block.wins}W</span> / <span className="text-red-500">{block.losses}L</span>
              {block.pending > 0 && <span className="ml-1 text-amber-500">+{block.pending} চলছে</span>}
            </p>
          )}
        </div>
        <Progress className="mt-3 h-1.5 bg-zinc-800" value={wr} />
        {block && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-400">
              কল {block.call.winRate}% <span className="text-zinc-500">({block.call.wins}/{block.call.wins + block.call.losses})</span>
            </div>
            <div className="rounded bg-red-500/10 px-2 py-1 text-red-400">
              পুট {block.put.winRate}% <span className="text-zinc-500">({block.put.wins}/{block.put.wins + block.put.losses})</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function fmtTime(ts: number, withSec = false): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', withSec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
}

export function fmtNum(n: number, digits: number): string {
  return n.toFixed(digits);
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">{children}</h2>;
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-zinc-800 text-sm text-zinc-500">
      {text}
    </div>
  );
}
