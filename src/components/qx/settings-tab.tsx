'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import type { BTSummary } from '@/lib/qx-types';
import { useEngine } from './engine-provider';
import { SectionTitle } from './bits';

export function SettingsTab() {
  const { settings, status, logs, rpc, connected, reconnect } = useEngine();
  const { toast } = useToast();
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [btRunning, setBtRunning] = useState(false);
  const [btSummary, setBtSummary] = useState<BTSummary | null>(null);
  const [selPairs, setSelPairs] = useState<string[]>([]);
  const [minConf, setMinConf] = useState(70);
  const [saving, setSaving] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (settings) {
      setSelPairs(settings.pairs);
      setMinConf(settings.minConfidence);
    }
  }, [settings]);

  useEffect(() => {
    rpc<{ ok: boolean; summary: BTSummary | null }>('get-backtest')
      .then((r) => { if (r.ok && r.summary) setBtSummary(r.summary); })
      .catch(() => {});
  }, [rpc]);

  const connect = async () => {
    if (!token.trim()) {
      toast({ title: 'টোকেন দিন', description: 'Quotex থেকে ssid সেশন টোকেন কপি করে পেস্ট করুন', variant: 'destructive' });
      return;
    }
    setConnecting(true);
    try {
      const r = await rpc<{ ok: boolean; msg: string }>('connect-token', { token: token.trim() });
      toast({ title: r.ok ? 'সংযোগ সফল' : 'সংযোগ ব্যর্থ', description: r.msg, variant: r.ok ? 'default' : 'destructive' });
      if (r.ok) setToken('');
    } catch (e: any) {
      toast({ title: 'ত্রুটি', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setConnecting(false);
    }
  };

  const disconnectLive = async () => {
    try {
      const r = await rpc<{ ok: boolean; msg: string }>('disconnect-live');
      toast({ title: 'লাইভ বন্ধ', description: r.msg });
    } catch { /* noop */ }
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await rpc<{ ok: boolean; msg: string }>('save-settings', {
        pairs: selPairs, minConfidence: minConf,
      });
      toast({ title: 'সংরক্ষিত', description: r.msg });
    } catch (e: any) {
      toast({ title: 'ত্রুটি', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const runBacktest = async () => {
    setBtRunning(true);
    try {
      const r = await rpc<{ ok: boolean; summary?: BTSummary; msg?: string }>('run-backtest');
      if (r.ok && r.summary) {
        setBtSummary(r.summary);
        toast({ title: 'ব্যাকটেস্ট সম্পন্ন', description: `${r.summary.overall.signals} সিগন্যাল — উইন রেট ${r.summary.overall.winRate}%` });
      } else {
        toast({ title: 'ব্যাকটেস্ট ব্যর্থ', description: r.msg ?? '', variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: 'ত্রুটি', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setBtRunning(false);
    }
  };

  const togglePair = (sym: string) =>
    setSelPairs((prev) => (prev.includes(sym) ? (prev.length > 1 ? prev.filter((p) => p !== sym) : prev) : [...prev, sym]));

  const chipCls = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400' : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
    }`;

  return (
    <div className="space-y-6">
      {/* QX token */}
      <section>
        <SectionTitle>Quotex সংযোগ (QX টোকেন)</SectionTitle>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${
                status?.mode === 'LIVE'
                  ? status?.feedProvider === 'quotex'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-teal-500/40 bg-teal-500/10 text-teal-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${
                  status?.mode === 'LIVE'
                    ? status?.feedProvider === 'quotex' ? 'bg-emerald-400' : 'bg-teal-300'
                    : 'bg-amber-400'
                } animate-pulse`} />
                {status?.mode === 'LIVE'
                  ? status?.feedProvider === 'quotex'
                    ? 'লাইভ Quotex টিক ডেটা চলছে'
                    : 'রিয়েল মার্কেট ডেটা চলছে (টোকেন দিলে Quotex টিকে সুইচ হবে)'
                  : 'Quotex সংযোগের অপেক্ষায়…'}
              </span>
              {settings?.tokenSource === 'env' && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-medium text-sky-400">
                  ⚙ QX_TOKEN ভ্যারিয়েবল সক্রিয় — রিস্টার্টে অটো-কানেক্ট
                </span>
              )}
              {settings?.tokenMasked && <span className="text-zinc-500">বর্তমান টোকেন: <span className="font-mono">{settings.tokenMasked}</span></span>}
              {status?.accountBalance != null && (
                <span className="text-zinc-400">ব্যালেন্স: <b className="text-emerald-400">{status.accountBalance} {status.currency ?? ''}</b></span>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="qx-token" className="text-zinc-300">QX সেশন টোকেন (authorization লাইন বা ssid কুকি)</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="qx-token"
                  type="password"
                  placeholder="উদাহরণ: QXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="border-zinc-700 bg-zinc-800/60 font-mono text-xs"
                  autoComplete="off"
                />
                <Button onClick={connect} disabled={connecting} className="bg-emerald-600 text-white hover:bg-emerald-500">
                  {connecting ? 'সংযোগ হচ্ছে...' : 'সংযোগ করুন'}
                </Button>
                <Button onClick={disconnectLive} variant="outline" className="border-zinc-700 text-zinc-300">
                  লাইভ বন্ধ
                </Button>
                {!connected && (
                  <Button onClick={reconnect} variant="outline" className="border-red-500/40 text-red-400">
                    ইঞ্জিন পুনঃসংযোগ
                  </Button>
                )}
              </div>
              {!connected && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
                  ⚠ ইঞ্জিনের সাথে সংযোগ এখন বিচ্ছিন্ন — তবে সব বাটন সচল: চাপলে অ্যাপ নিজেই পুনঃসংযোগের চেষ্টা করবে (১২ সে.)।
                  ইঞ্জিন চালু থাকলে সব ঠিক হয়ে যাবে; ডিপ্লয়ে <span className="font-mono">/qx-health</span> চেক করুন (DEPLOY.md)।
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-zinc-500">
                <b className="text-zinc-400">টোকেন কীভাবে নিবেন (২ উপায় — ① সবচেয়ে নির্ভরযোগ্য):</b>
                <br />
                <span className="text-zinc-400">①</span> qxbroker.com-এ লগইন করুন → <b className="text-zinc-400">F12</b> → <b className="text-zinc-400">Network</b> ট্যাব → <b className="text-zinc-400">WS</b> লিখে ফিল্টার করুন → socket.io/ws2 কানেকশনে ক্লিক করুন → <b className="text-zinc-400">Messages</b> ট্যাব → আপনার ব্রাউজারের পাঠানো সবুজ রঙের <span className="font-mono text-zinc-400">42[&quot;authorization&quot;,&#123;&quot;session&quot;:&quot;…&quot;&#125;]</span> লাইনটি <b className="text-zinc-400">পুরোপুরি কপি</b> করে এখানে পেস্ট করুন।
                <br />
                <span className="text-zinc-400">②</span> DevTools → <b className="text-zinc-400">Application</b> → Cookies → <span className="font-mono text-zinc-400">ssid</span> (বা <span className="font-mono text-zinc-400">q9securid</span>)-এর ভ্যালু কপি করুন।
                <br />
                <span className="text-amber-500/80">⚠</span> পুরো authorization লাইন পেস্ট করলেও হবে — অ্যাপ নিজে টোকেনটি বের করে নেয়। টোকেন কয়েক ঘণ্টা/দিন পর <b className="text-zinc-400">মেয়াদ শেষ হয়ে যায়</b> — তখন "প্রত্যাখ্যাত" দেখালে নতুন করে কপি করতে হবে। টোকেন সার্ভারে সংরক্ষিত হয়, ব্রাউজারে ফুল টোকেন আর দেখা যায় না।
                <br />
                <span className="text-zinc-400">অটো-সেটআপ:</span> Railway Variables-এ <span className="font-mono text-zinc-400">QX_TOKEN</span> সেট করলে টোকেন পেস্ট করতেই হবে না — রিস্টার্টে নিজে লাইভ হবে।
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* engine settings */}
      <section>
        <SectionTitle>ইঞ্জিন সেটিংস</SectionTitle>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="space-y-4 p-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-400">সক্রিয় পেয়ার ({selPairs.length})</p>
              <div className="flex flex-wrap gap-2">
                {(settings?.allPairs ?? []).map((p) => (
                  <button key={p.symbol} onClick={() => togglePair(p.symbol)} className={chipCls(selPairs.includes(p.symbol))}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-zinc-300">
                  ন্যূনতম কনফিডেন্স: <b className="text-emerald-400 tabular-nums">{minConf}%</b>
                </Label>
                <input
                  type="range" min={50} max={95} step={5} value={minConf}
                  onChange={(e) => setMinConf(Number(e.target.value))}
                  className="w-full accent-emerald-500"
                  aria-label="ন্যূনতম কনফিডেন্স"
                />
                <p className="text-[11px] text-zinc-500">বেশি কনফিডেন্স = কম কিন্তু মানসম্মত সিগন্যাল। ৭০% ব্যালেন্সড।</p>
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300">ডেটা ফিড</Label>
                <div className="rounded-md border border-teal-500/30 bg-teal-500/5 px-3 py-2.5 text-xs leading-relaxed text-teal-200/90">
                  <b>রিয়েল-ডেটা-অনলি ইঞ্জিন (Python)</b>
                  <br />
                  Quotex সেশন টোকেন দিলে ws2.qxbroker.com থেকে টিক-বাই-টিক লাইভ ফিড + আপনার ব্যালেন্স আসে।
                  টোকেন না থাকলে একই পেয়ারের রিয়েল ইন্টারব্যাংক মার্কেট ডেটা চলে — কোনো সিমুলেশন নেই।
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={save} disabled={saving} className="bg-emerald-600 text-white hover:bg-emerald-500">
                {saving ? 'সংরক্ষণ হচ্ছে...' : 'সংরক্ষণ করুন'}
              </Button>
              <Button onClick={reconnect} variant="outline" className="border-zinc-700 text-zinc-300">সকেট রিকানেক্ট</Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* backtest */}
      <section>
        <SectionTitle>ব্যাকটেস্ট ও ভেরিফিকেশন</SectionTitle>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>ওয়াক-ফরওয়ার্ড ব্যাকটেস্ট (শেষ ~২ দিনের ১ম ক্যান্ডেল)</span>
              <Button onClick={runBacktest} disabled={btRunning} size="sm" className="bg-emerald-600 text-white hover:bg-emerald-500">
                {btRunning ? 'চলছে...' : 'ব্যাকটেস্ট চালান'}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            {btRunning && <Skeleton className="h-40 w-full" />}
            {!btRunning && !btSummary && (
              <p className="text-sm text-zinc-500">বাটন চাপুন — ইঞ্জিন হিস্ট্রি ক্যান্ডেলে হুবহু লাইভ-স্ট্র্যাটেজি চালিয়ে উইন রেট বের করবে (লুক-অ্যাহেড ছাড়া)।</p>
            )}
            {!btRunning && btSummary && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                  <div className="rounded bg-zinc-800/60 px-2 py-2.5">
                    <p className="text-[11px] text-zinc-500">মোট সিগন্যাল</p>
                    <p className="text-xl font-bold tabular-nums text-zinc-100">{btSummary.overall.signals}</p>
                  </div>
                  <div className="rounded bg-zinc-800/60 px-2 py-2.5">
                    <p className="text-[11px] text-zinc-500">উইন রেট</p>
                    <p className={`text-xl font-bold tabular-nums ${btSummary.overall.winRate >= 60 ? 'text-emerald-400' : btSummary.overall.winRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                      {btSummary.overall.winRate}%
                    </p>
                  </div>
                  <div className="rounded bg-emerald-500/10 px-2 py-2.5 text-emerald-400">
                    <p className="text-[11px] text-emerald-600">উইন / লস</p>
                    <p className="text-xl font-bold tabular-nums">{btSummary.overall.wins} / {btSummary.overall.losses}</p>
                  </div>
                  <div className="rounded bg-zinc-800/60 px-2 py-2.5">
                    <p className="text-[11px] text-zinc-500">ক্যান্ডেল টেস্টেড</p>
                    <p className="text-xl font-bold tabular-nums text-zinc-100">{btSummary.candlesTested.toLocaleString()}</p>
                  </div>
                </div>

                <ScrollArea className="max-h-64">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
                      <tr className="border-b border-zinc-800">
                        <th className="px-2 py-1.5 text-left font-medium">পেয়ার</th>
                        <th className="px-2 py-1.5 text-right font-medium">সিগন্যাল</th>
                        <th className="px-2 py-1.5 text-right font-medium">উইন রেট</th>
                        <th className="px-2 py-1.5 text-right font-medium">কল WR</th>
                        <th className="px-2 py-1.5 text-right font-medium">পুট WR</th>
                        <th className="px-2 py-1.5 text-right font-medium">সর্বোচ্চ W/L স্ট্রিক</th>
                      </tr>
                    </thead>
                    <tbody>
                      {btSummary.perPair.map((p) => (
                        <tr key={p.pair} className="border-b border-zinc-800/60 last:border-0">
                          <td className="px-2 py-1.5 font-medium text-zinc-200">{p.pair}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{p.signals}</td>
                          <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${p.winRate >= 60 ? 'text-emerald-400' : p.winRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>{p.winRate}%</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-emerald-400/80">{p.callSignals ? Math.round((p.callWins / p.callSignals) * 100) : 0}%</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-red-400/80">{p.putSignals ? Math.round((p.putWins / p.putSignals) * 100) : 0}%</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-zinc-500">{p.maxWinStreak} / {p.maxLossStreak}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>

                <p className="text-[11px] leading-relaxed text-zinc-500">
                  ব্যাকটেস্ট রান: {new Date(btSummary.ranAt).toLocaleString('en-GB')} | ন্যূনতম কনফিডেন্স {btSummary.minConfidence}% |
                  পরিসর: {new Date(btSummary.from).toLocaleString('en-GB')} → {new Date(btSummary.to).toLocaleString('en-GB')} |
                  ডেটা সোর্স: রিয়েল মার্কেট ক্যান্ডেল (Quotex টোকেন যুক্ত থাকলে Quotex হিস্ট্রি)।
                  সতর্কতা: অতীত পারফরম্যান্স ভবিষ্যতের নিশ্চয়তা নয়।
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* connection log */}
      <section>
        <SectionTitle>ইঞ্জিন ও কানেকশন লগ</SectionTitle>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <ScrollArea className="max-h-56">
              <div className="space-y-1 font-mono text-[11px]">
                {logs.length === 0 && <p className="text-zinc-500">লগ নেই</p>}
                {logs.slice().reverse().map((l, i) => (
                  <p key={i} className={l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : 'text-zinc-400'}>
                    <span className="text-zinc-600">[{new Date(l.t).toLocaleTimeString('en-GB')}]</span> {l.msg}
                  </p>
                ))}
              </div>
            </ScrollArea>
            <Separator className="my-3 bg-zinc-800" />
            <details className="text-xs text-zinc-400" onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer select-none text-zinc-500">র Quotex WS raw ইভেন্ট (লাইভ ডিবাগিং)</summary>
              <ScrollArea className="mt-2 max-h-40">
                <div className="space-y-0.5 font-mono text-[10px] text-zinc-500">
                  <GetRaw />
                </div>
              </ScrollArea>
            </details>
          </CardContent>
        </Card>
      </section>

      {/* risk disclaimer */}
      <section>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-4">
            <p className="text-xs leading-relaxed text-amber-200/90">
              <b>⚠️ ঝুঁকি সতর্কতা:</b> বাইনারি অপশন ট্রেডিং অত্যন্ত ঝুঁকিপূর্ণ — বেশিরভাগ ট্রেডার টাকা হারায়। এই অ্যাপ একটি
              টেকনিক্যাল অ্যানালাইসিস টুল; কোনো সিগন্যাল নিশ্চিত লাভের নিশ্চয়তা নয়। লাইভ টাকা দিয়ে ট্রেডের আগে নিজের ঝুঁকি-বহনক্ষমতা
              যাচাই করুন, ছোট স্টেকে শুরু করুন এবং কখনো ধার নেওয়া টাকা দিয়ে ট্রেড করবেন না। Quotex অ্যাকাউন্টের সব ট্রেড সিদ্ধান্ত আপনার নিজের।
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function GetRaw() {
  const { rpc, connected } = useEngine();
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!connected) return;
    const load = () => rpc<{ raw: string[] }>('get-log').then((r) => setLines(r.raw ?? [])).catch(() => {});
    void load();
    const iv = setInterval(() => void load(), 4000);
    return () => clearInterval(iv);
  }, [rpc, connected]);
  if (!lines.length) return <p className="px-2 text-zinc-600">লাইভ সংযোগের পর এখানে raw WS ইভেন্ট দেখা যাবে</p>;
  return (
    <>
      {lines.slice().reverse().map((l, i) => (
        <p key={i} className={l.startsWith('→') ? 'text-emerald-600' : 'text-zinc-500'}>{l}</p>
      ))}
    </>
  );
}
