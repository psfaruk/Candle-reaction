'use client';

import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EngineProvider, useEngine } from '@/components/qx/engine-provider';
import { HomeTab } from '@/components/qx/home-tab';
import { SignalsTab } from '@/components/qx/signals-tab';
import { SettingsTab } from '@/components/qx/settings-tab';

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // start ticking from a timer callback (external system), not synchronously,
    // so server/client markup stays identical on first paint
    const tick = () => setNow(new Date());
    const t = setTimeout(tick, 0);
    const iv = setInterval(tick, 1000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, []);
  // avoid hydration mismatch: render after mount
  if (!now) return <span className="font-mono text-xs text-zinc-500">--:--:--</span>;
  return <span className="font-mono text-xs tabular-nums text-zinc-500">{now.toLocaleTimeString('en-GB')}</span>;
}

function StatusBadges() {
  const { connected, status } = useEngine();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        connected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-400'
      }`}>
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'} animate-pulse`} />
        {connected ? 'ইঞ্জিন সংযুক্ত' : 'সংযোগ বিচ্ছিন্ন'}
      </span>
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        status?.mode === 'LIVE'
          ? status?.feedProvider === 'quotex'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
            : 'border-teal-500/40 bg-teal-500/10 text-teal-300'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
      }`}>
        {status?.mode === 'LIVE'
          ? status?.feedProvider === 'quotex'
            ? `● লাইভ Quotex (টিক, ${status?.accountMode === 'real' ? 'রিয়েল' : 'ডেমো'})`
            : '● রিয়েল মার্কেট ডেটা'
          : '● সংযোগ হচ্ছে…'}
      </span>
      {status && (
        <span className="hidden rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-[11px] text-zinc-400 sm:inline-flex">
          পেয়ার {status.activePairs.length} | কনফিডেন্স ≥ {status.minConfidence}%
        </span>
      )}
      <Clock />
    </div>
  );
}

function QxApp() {
  return (
    <div className="flex min-h-screen flex-col bg-[#090c11] text-zinc-100">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-[#090c11]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 text-sm font-black text-white shadow-lg shadow-emerald-900/40">
              QX
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight text-zinc-100 sm:text-base">ক্যান্ডেল রিয়েকশন সিগন্যাল ইঞ্জিন</h1>
              <p className="text-[10px] leading-tight text-zinc-500">লেভেল/জোন + স্ট্রাকচার + ফুল ক্লোজ + রিয়েকশন = কনফার্মেশন</p>
            </div>
          </div>
          <StatusBadges />
        </div>
      </header>

      {/* main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        <Tabs defaultValue="home" className="w-full">
          <TabsList className="mb-4 grid h-auto w-full max-w-md grid-cols-3 rounded-lg border border-zinc-800 bg-zinc-900/80 p-1">
            <TabsTrigger value="home" className="rounded-md py-2 text-xs font-medium data-[state=active]:bg-emerald-600/20 data-[state=active]:text-emerald-400 sm:text-sm">
              হোম
            </TabsTrigger>
            <TabsTrigger value="signals" className="rounded-md py-2 text-xs font-medium data-[state=active]:bg-emerald-600/20 data-[state=active]:text-emerald-400 sm:text-sm">
              সিগন্যাল
            </TabsTrigger>
            <TabsTrigger value="settings" className="rounded-md py-2 text-xs font-medium data-[state=active]:bg-emerald-600/20 data-[state=active]:text-emerald-400 sm:text-sm">
              সেটিংস
            </TabsTrigger>
          </TabsList>
          <TabsContent value="home"><HomeTab /></TabsContent>
          <TabsContent value="signals"><SignalsTab /></TabsContent>
          <TabsContent value="settings"><SettingsTab /></TabsContent>
        </Tabs>
      </main>

      {/* footer */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-[#090c11]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-zinc-500">
          <span>QX ক্যান্ডেল সিগন্যাল — ১ মিনিটের বাইনারি কনফার্মেশন টুল</span>
          <span>টিক-ভিত্তিক ইঞ্জিন • সিগন্যাল শুধু ক্যান্ডেল ফুল ক্লোজে • শিক্ষামূলক ব্যবহারের জন্য</span>
        </div>
      </footer>
    </div>
  );
}

export default function Page() {
  return (
    <EngineProvider>
      <QxApp />
    </EngineProvider>
  );
}
