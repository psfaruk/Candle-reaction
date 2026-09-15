'use client';

import { useEffect, useRef } from 'react';
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type SeriesMarker, type Time,
} from 'lightweight-charts';
import type { Candle, SignalRec } from '@/lib/qx-types';

interface Props {
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

export default function CandleChart({ candles, signals, digits, height = 380 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lastLenRef = useRef(0);
  const lastSigRef = useRef(0);

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

    const ro = new ResizeObserver(() => {
      if (wrapRef.current) chart.applyOptions({ width: wrapRef.current.clientWidth });
    });
    ro.observe(wrapRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lastLenRef.current = 0;
    };
  }, [digits, height]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.length) return;
    const sigKey = signals.map((s) => `${s.id}${s.result}`).join('|');
    if (candles.length !== lastLenRef.current || candles[0].ts !== (series as any)._firstTs) {
      series.setData(candles.map(toBar));
      (series as any)._firstTs = candles[0].ts;
      lastLenRef.current = candles.length;
    } else {
      series.update(toBar(candles[candles.length - 1]));
    }
    if (sigKey !== lastSigRef.current) {
      series.setMarkers(toMarkers(signals));
      lastSigRef.current = sigKey;
    }
  }, [candles, signals]);

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
