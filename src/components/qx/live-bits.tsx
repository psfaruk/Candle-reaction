'use client';

// ============ লাইভ ডিসপ্লে উপাদান — ৬০fps, React রি-রেন্ডার ছাড়া ============
// SmoothPrice: rAF লুপ সরাসরি DOM-এ লেখে (state নেই) — ৮-১২ টিক/সেকেন্ড
// এলেও চোখে দেখে নিরবচ্ছিন্ন ৬০fps মোশন।
// useSecondsLeft: সার্ভারের ১s স্ন্যাপশটের ওপর নির্ভর না করে লোকাল ঘড়িতে
// কাউন্টডাউন — মিলিসেকেন্ড-নির্ভুল, কখনো আটকে থাকে না।

import { useEffect, useRef, useState } from 'react';
import { tickStore } from './tick-store';

/** rAF-স্মুথড ডিজিটাল দাম — টিকের মাঝের মান ক্ষেপণ করে দেখায় */
export function SmoothPrice({
  pair, digits, className, fallback,
}: { pair: string | null | undefined; digits: number; className?: string; fallback?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let disp: number | null = null;
    let last = performance.now();
    const TAU = 110; // ms — স্মুথিং ধ্রুবক
    const frame = () => {
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      const q = pair ? tickStore.get(pair) : null;
      if (q && Number.isFinite(q.c) && q.c > 0) {
        if (disp === null) disp = q.c;
        disp += (q.c - disp) * (1 - Math.exp(-dt / TAU));
        if (Math.abs(q.c - disp) < Math.pow(10, -digits) / 2) disp = q.c;
        if (spanRef.current) spanRef.current.textContent = disp.toFixed(digits);
      } else if (spanRef.current && fallback !== undefined && spanRef.current.textContent !== fallback) {
        spanRef.current.textContent = fallback;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pair, digits, fallback]);

  return <span ref={spanRef} className={className}>—</span>;
}

/** লোকাল-ক্লক কাউন্টডাউন — মিনিট ওপেন-টাইম থেকে বাকি সেকেন্ড */
export function useSecondsLeft(tsMs: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tsMs) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [tsMs]);
  if (!tsMs) return 0;
  const left = 60 - Math.floor((now - tsMs) / 1000);
  return Math.max(0, Math.min(60, left));
}

/** লোকাল-ক্লক (২৫০ms) — যেকোনো জায়গায় ফ্রেশ সময় */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}
