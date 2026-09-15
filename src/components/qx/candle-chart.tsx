'use client';

import { useEffect, useRef } from 'react';
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type SeriesMarker, type Time,
} from 'lightweight-charts';
import type { Candle, SignalRec } from '@/lib/qx-types';
import { tickStore } from './tick-store';

interface Props {
  pair: string;
  candles: Candle[];
  signals: SignalRec[];
  digits: number;
  height?: number;
}

const OFFSET_MS = new Date().getTimezoneOffset() * 60000;

function toBar(c: Candle) {
  return {
    time: ((c.ts - OFFSET_MS) / 1000) as UTCTimestamp,
    open: c.open, high: c.high, low: c.low, close: c.close,
  };
}

function toMarkers(signals: SignalRec[]): SeriesMarker<Time>[] {
  const mk: SeriesMarker<Time>[] = [];
  for (const s of signals) {
    const t = ((s.ts - OFFSET_MS) / 1000) as UTCTimestamp;
    const color =
      s.result === 'WIN' ? '#22c55e' : s.result === 'LOSS' ? '#ef4444' : s.result === 'TIE' ? '#94a3b8' : '#eab308';
    mk.push({
      time: t,
      position: s.direction === 'CALL' ? 'belowBar' : 'aboveBar',
      shape: s.direction === 'CALL' ? 'arrowUp' : 'arrowDown',
      color,
      text: `${s.confidence}${s.result === 'WIN' ? ' ✓' : s.result === 'LOSS' ? ' ✕' : ''}`,
      size: 1,
    });
  }
  return mk.sort((a, b) => (a.time as number) - (b.time as number));
}

/**
 * ৬০fps স্মুথ ক্যান্ডেল-চার্ট।
 *
 * ডেটা-পাথ দুইটা:
 *  ① হিস্ট্রি (candles prop) → setData — পেয়ার/দৈর্ঘ্য বদলালেই সম্পূর্ণ রিসেট
 *     (আগের বাগ: একই দৈর্ঘ্য+একই first-ts হলে series.update() ভিন্ন ডেটাসেটে
 *      চলে গিয়ে "Cannot update oldest data" এ চার্ট ভেঙে যেত)
 *  ② লাইভ টিক (tick-store, ১০Hz) → requestAnimationFrame লুপ প্রতি ফ্রেমে
 *     দামকে টার্গেটের দিকে এক্সপোনেনশিয়ালি স্মুথ করে series.update() ডাকে —
 *     ফলে ৮-১২ টিক/সেকেন্ডও চোখে ৬০fps-এর মতো নিরবচ্ছিন্ন মোশনে দেখায়।
 */
export default function CandleChart({ pair, candles, signals, digits, height = 380 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const dataKeyRef = useRef('');
  const lastSigRef = useRef('');
  const viewInitRef = useRef('');   // কোন পেয়ারের ওপেনিং-ভিউ সেট হয়েছে

  // rAF লুপের লাইভ অবস্থা (রেন্ডারের বাইরে — রি-রেন্ডারেও অ্যানিমেশন থামে না)
  const animRef = useRef({
    bar: null as { time: number; open: number; high: number; low: number; close: number } | null,
    barMs: 0,            // বর্তমান বারের ওপেন-টাইম (ms)
    display: 0,          // বর্তমানে দেখানো দাম (স্মুথড)
    lastDataTime: 0,     // setData/update দিয়ে বসানো শেষ বারের টাইম (সেকেন্ড)
    raf: 0,
  });
  const priceLineRef = useRef<IPriceLine | null>(null);
  const propsRef = useRef({ pair, digits });
  // rAF লুপ সবসময় ফ্রেশ prop দেখবে (রেন্ডারে নয়, effect-এ সিঙ্ক — react-hooks/refs)
  useEffect(() => {
    propsRef.current = { pair, digits };
  }, [pair, digits]);

  // ---- chart lifecycle (digits/height বদলালে নতুন চার্ট) ----
  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      width: wrapRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#0b0f14' },
        textColor: '#8b949e',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#151b23' }, horzLines: { color: '#151b23' } },
      rightPriceScale: { borderColor: '#1c2430' },
      timeScale: { borderColor: '#1c2430', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'en' },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#16a34a', downColor: '#dc2626',
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
      borderVisible: false,
      priceFormat: { type: 'price', precision: digits, minMove: Math.pow(10, -digits) },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    dataKeyRef.current = '';   // নতুন সিরিজ → পরের ইফেক্টে ফুল setData নিশ্চিত

    const ro = new ResizeObserver(() => {
      if (wrapRef.current) chart.applyOptions({ width: wrapRef.current.clientWidth });
    });
    ro.observe(wrapRef.current);

    // ---- ৬০fps অ্যানিমেশন লুপ ----
    const SMOOTH_TAU = 90;     // ms — টার্গেটে পৌঁছানোর সময়-ধ্রুবক (দ্রুত কিন্তু মসৃণ)
    let lastFrame = performance.now();
    const frame = () => {
      const now = performance.now();
      const dt = Math.min(100, now - lastFrame);
      lastFrame = now;
      const s = seriesRef.current;
      if (s) {
        const { pair: p } = propsRef.current;
        const q = tickStore.get(p);
        if (q && q.c > 0) {
          const st = animRef.current;
          const target = q.c;
          const tMs = q.ts;
          const tSec = (tMs - OFFSET_MS) / 1000;
          if (!st.bar || st.barMs !== tMs) {
            if (st.bar && tMs < st.barMs) {
              // পুরনো/অগোছালো টিক — বর্তমান বারই থাকবে
            } else {
              // নতুন মিনিটের ক্যান্ডেল শুরু: আগের ক্লোজ থেকে ওপেন
              const prevClose = st.bar ? st.bar.close : q.o;
              const openPrice = st.bar ? prevClose : q.o;
              st.bar = {
                time: tSec,
                open: openPrice,
                high: Math.max(openPrice, target, q.h),
                low: Math.min(openPrice, target, q.l),
                close: target,
              };
              st.barMs = tMs;
              if (st.display === 0) st.display = target;
            }
          } else {
            // এক্সপোনেনশিয়াল স্মুথিং — প্রতি ফ্রেমে টার্গেটের দিকে মসৃণ অগ্রগতি
            const k = 1 - Math.exp(-dt / SMOOTH_TAU);
            st.display += (target - st.display) * k;
            st.bar.close = st.display;
          }
          // ইঞ্জিনের authoritative high/low কখনো কমবে না
          st.bar.high = Math.max(st.bar.high, q.h, st.display);
          st.bar.low = Math.min(st.bar.low, q.l, st.display);
          if (st.bar.time >= st.lastDataTime) {
            try {
              s.update({ ...st.bar, time: st.bar.time as UTCTimestamp });
            } catch { /* time-order race — পরের setData ঠিক করবে */ }
          }
          // অ্যানিমেটেড প্রাইস-লাইন (তৈরি একবার — প্রতি ফ্রেমে শুধু দাম/রঙ বদলায়)
          if (!priceLineRef.current) {
            priceLineRef.current = s.createPriceLine({
              price: st.display, color: '#16a34a', lineWidth: 1, lineStyle: 0,
              axisLabelVisible: true, title: '',
            });
          }
          priceLineRef.current.applyOptions({
            price: st.display,
            color: st.display >= st.bar.open ? '#16a34a' : '#dc2626',
          });
        }
      }
      animRef.current.raf = requestAnimationFrame(frame);
    };
    animRef.current.raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animRef.current.raf);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLineRef.current = null;
      animRef.current.bar = null;
      animRef.current.barMs = 0;
      animRef.current.display = 0;
      animRef.current.lastDataTime = 0;
      dataKeyRef.current = '';
    };
  }, [digits, height]);

  // ---- হিস্ট্রি সেট (পেয়ার বদলালেও সবসময় সঠিক) ----
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.length) return;
    const sigKey = signals.map((s) => `${s.id}${s.result}`).join('|');
    // পেয়ার + দৈর্ঘ্য + প্রথম টাইমস্ট্যাম্প — যেকোনো একটা বদলালেই সম্পূর্ণ রিসেট।
    // পেয়ার-সুইচে দুই পেয়ারের দৈর্ঘ্য/প্রথম-ts মিলে গেলেও pair-অংশ আলাদা →
    // setData-ই হবে, পুরনো ডেটার ওপর update() করে চার্ট আর ভাঙবে না।
    const dataKey = `${pair}|${candles.length}|${candles[0].ts}`;
    if (dataKey !== dataKeyRef.current) {
      series.setData(candles.map(toBar));
      dataKeyRef.current = dataKey;
      // Quotex-অ্যাপের মতো ওপেনিং ভিউ — শুধু পেয়ার বদলানোর সময় (রিফেচে
      // ইউজারের স্ক্রল-জুম থাকবে); শেষ ~১২০ ক্যান্ডেল দেখা যাবে, বাকিটা
      // স্ক্রল করে (গভীর হিস্ট্রি ইঞ্জিন জমিয়ে রাখে)
      if (viewInitRef.current !== pair) {
        viewInitRef.current = pair;
        try {
          chartRef.current?.timeScale().setVisibleLogicalRange({
            from: Math.max(0, candles.length - 120),
            to: candles.length + 3,
          });
        } catch { /* ডেটা কম হলে নিরাপদ */ }
      }
      const st = animRef.current;
      const lastBar = toBar(candles[candles.length - 1]);
      st.lastDataTime = lastBar.time as number;
      st.display = lastBar.close;   // অ্যানিমেশন এখান থেকে শুরু
      // লাইভ টিকের মিনিট হিস্ট্রির শেষ মিনিটের সাথে মিললে অ্যানিমেশন ওখান থেকেই চলবে,
      // নতুন মিনিট হলে rAF লুপ নিজেই নতুন বার খুলবে — bar রিসেট করলেই যথেষ্ট
      animRef.current.bar = null;
      animRef.current.barMs = 0;
    } else {
      // একই ডেটাসেট — শুধু শেষ বার রিফ্রেশ (যেমন হিস্ট্রি রিপোল্লে)
      const lastBar = toBar(candles[candles.length - 1]);
      try { series.update(lastBar); } catch { /* noop */ }
      animRef.current.lastDataTime = Math.max(animRef.current.lastDataTime, lastBar.time as number);
    }
    if (sigKey !== lastSigRef.current) {
      series.setMarkers(toMarkers(signals));
      lastSigRef.current = sigKey;
    }
  }, [pair, candles, signals]);

  return (
    <div
      ref={wrapRef}
      className="w-full rounded-md border border-zinc-800 bg-[#0b0f14]"
      style={{ height }}
      role="img"
      aria-label="ক্যান্ডেলস্টিক চার্ট"
    />
  );
}
