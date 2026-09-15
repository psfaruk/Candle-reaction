// ============ QX Tick Store — ফাস্ট টিক-স্ট্রিম (১০Hz) ============
// ইঞ্জিনের `ticks` ইভেন্ট থেকে সরাসরি এখানে জমে (React state স্কিপ)।
// useSyncExternalStore দিয়ে যে-কোনো ছোট কম্পোনেন্ট ১০Hz-এ সস্তায় রি-রেন্ডার করে;
// চার্টের ৬০fps অ্যানিমেশন rAF লুপ থেকে সরাসরি এই স্টোর পড়ে (রেন্ডার ছাড়াই)।

import { useSyncExternalStore } from 'react';

export interface LiveQuote {
  pair: string;
  /** রানিং ক্যান্ডেলের ওপেন-টাইম (ms, মিনিট-অ্যালাইনড) */
  ts: number;
  o: number;
  h: number;
  l: number;
  /** সর্বশেষ দাম */
  c: number;
  /** মোট টিক / আপ / ডাউন (ক্যান্ডেলের শুরু থেকে) */
  tk: number;
  up: number;
  dn: number;
  /** ইঞ্জিন-সার্ভার টাইমস্ট্যাম্প (ms) */
  t: number;
  /** লোকাল রিসিভ-টাইম (performance.now()) — ইন্টারপোলেশনের জন্য */
  recvAt: number;
}

type Listener = () => void;

class TickStore {
  private quotes = new Map<string, LiveQuote>();
  private listeners = new Set<Listener>();
  /** ব্যাচ-নোটিফি: ১০Hz-এর বেশি রেন্ডার-নোটিফি হবে না */
  private notifyScheduled = false;
  version = 0;

  ingest(batch: { p: string; ts: number; o: number; h: number; l: number; c: number; tk: number; up: number; dn: number; t: number }[]) {
    const now = performance.now();
    for (const q of batch) {
      if (!q || typeof q.c !== 'number' || !Number.isFinite(q.c)) continue;
      this.quotes.set(q.p, { ...q, pair: q.p, recvAt: now });
    }
    this.version++;
    if (!this.notifyScheduled) {
      this.notifyScheduled = true;
      // এক ফ্রেমের মধ্যে একাধিক ব্যাচ এলে একবারই নোটিফি
      setTimeout(() => {
        this.notifyScheduled = false;
        this.listeners.forEach((l) => l());
      }, 0);
    }
  }

  get(pair: string): LiveQuote | null {
    return this.quotes.get(pair) ?? null;
  }

  /** সর্বশেষ স্ন্যাপশট-মার্জড দাম (মার্কেট স্ন্যাপশটের running থেকে ফলব্যাক) */
  seedFromSnapshot(pairs: { pair: string; running: { ts: number; open: number; high: number; low: number; last: number; ticks: number; upTicks: number; downTicks: number } }[] | undefined) {
    if (!pairs) return;
    for (const p of pairs) {
      if (!this.quotes.has(p.pair) && p.running) {
        this.quotes.set(p.pair, {
          pair: p.pair, ts: p.running.ts, o: p.running.open, h: p.running.high,
          l: p.running.low, c: p.running.last, tk: p.running.ticks,
          up: p.running.upTicks, dn: p.running.downTicks, t: Date.now(),
          recvAt: performance.now(),
        });
      }
    }
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.version;
}

export const tickStore = new TickStore();

/** পেয়ারের লাইভ কোট — ১০Hz পর্যন্ত রি-রেন্ডার (React 18 external store) */
export function useLiveQuote(pair: string | null | undefined): LiveQuote | null {
  const v = useSyncExternalStore(tickStore.subscribe, tickStore.getSnapshot, () => 0);
  void v; // version পরিবর্তন = নতুন টিক এসেছে → নিচের গেটার থেকে ফ্রেশ ভ্যালু
  return pair ? tickStore.get(pair) : null;
}
