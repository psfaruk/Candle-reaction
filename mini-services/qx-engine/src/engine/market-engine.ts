import type { Server } from 'socket.io';
import type {
  Candle, EngineStatus, FeedSource, LogLine, MarketSnapshot, PairDef, PairMarketState,
  Reason, RunningCandleState, SignalRec, StatsBlock, PairStat, SignalFilter, LiveScorePreview,
} from '../types';
import { ALL_PAIRS, getPairDef } from '../pairs';
import { db } from '../db';
import { TickSimulator } from './simulator';
import { QuotexClient } from './quotex-client';
import { PairCandleStore } from './candle-store';
import { detectZones } from './levels';
import { evaluateSignal, previewRunningScore } from './signal-engine';
import { backtestPair, aggregateBacktest, type BTSummary, type BTSignal } from './backtest';

const MINUTE = 60000;
const HISTORY_MINUTES = 2880; // 2 days
const LIVE_TICK_TIMEOUT = 15000;

export class MarketEngine {
  private stores = new Map<string, PairCandleStore>();
  private sim: TickSimulator;
  private qx: QuotexClient | null = null;
  private io: Server | null = null;

  feed: FeedSource = 'SIM';
  private desiredMode: 'auto' | 'live' | 'simulation' = 'auto';
  private activePairs: string[] = [];
  private minConfidence = 70;
  private qxToken: string | null = null;
  private tokenSource: 'env' | 'db' = 'db';

  private lastMinute = 0;
  private pending = new Map<string, SignalRec>(); // pair -> awaiting resolution
  private lastLiveTickAt = 0;

  private startedAt = Date.now();
  private logs: LogLine[] = [];
  private rawLog: string[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private minuteTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private account = { balance: null as number | null, currency: null as string | null, login: null as string | null };
  private signalsGenerated = 0;

  constructor() {
    this.sim = new TickSimulator((m) => this.log('info', m));
  }

  // ---------------- lifecycle ----------------

  async start(io: Server) {
    this.io = io;
    const s = await db.setting.findUnique({ where: { id: 'main' } });
    this.minConfidence = s?.minConfidence ?? 70;
    this.desiredMode = (s?.mode as any) ?? 'auto';
    // QX_TOKEN env var wins (Railway Variables → fully automatic live setup)
    const envToken = (process.env.QX_TOKEN || '').trim();
    this.tokenSource = envToken ? 'env' : 'db';
    const token = envToken || s?.qxToken || null;
    this.activePairs = (s?.pairs ?? ALL_PAIRS.map((p) => p.symbol)).split(',').filter(Boolean);

    this.log('info', `ইঞ্জিন চালু — ${this.activePairs.length}টি পেয়ার, মোড: ${this.desiredMode}${envToken ? ', টোকেন: QX_TOKEN env থেকে (অটো)' : ''}`);

    // load / generate history for each pair
    for (const sym of this.activePairs) {
      await this.initPair(sym);
    }

    // try live if token + mode allows
    if (token && this.desiredMode !== 'simulation') {
      await this.startLive(token);
    } else {
      this.log('info', token ? 'মোড simulation — লাইভ সংযোগ বন্ধ রাখা হয়েছে' : 'QX টোকেন নেই — সিমুলেশন ফিড চালু (Settings ট্যাব বা QX_TOKEN env ভ্যারিয়েবল থেকে টোকেন দিন)');
    }

    this.lastMinute = Math.floor(Date.now() / MINUTE);
    // ensure running candles exist
    for (const sym of this.activePairs) {
      const st = this.stores.get(sym)!;
      if (!st.running) {
        const lastClose = st.candles.length ? st.candles[st.candles.length - 1].close : getPairDef(sym).basePrice;
        st.startRunning(this.lastMinute * MINUTE, lastClose);
        this.sim.initPair(getPairDef(sym), lastClose);
      }
    }

    this.tickTimer = setInterval(() => this.simTickLoop(), 250);
    this.minuteTimer = setInterval(() => this.minuteWatcher(), 200);
    this.broadcastTimer = setInterval(() => this.broadcast(), 1000);
    this.log('info', 'ইঞ্জিন সম্পূর্ণ চালু — ক্যান্ডেল ক্লোজে সিগন্যাল মূল্যায়ন সক্রিয়');
  }

  private async initPair(sym: string) {
    const def = getPairDef(sym);
    let candles = await this.loadCandlesFromDb(sym, 700);
    const nowMin = Math.floor(Date.now() / MINUTE);
    const haveFrom = candles.length ? candles[0].ts : 0;
    const wantFrom = (nowMin - HISTORY_MINUTES) * MINUTE;
    if (candles.length < 120 || haveFrom > wantFrom + 5 * MINUTE) {
      // not enough history → generate sim history for the missing stretch
      const genFrom = candles.length ? Math.max(wantFrom, candles[candles.length - 1].ts + MINUTE) : wantFrom;
      const minutes = Math.floor((nowMin * MINUTE - genFrom) / MINUTE);
      if (minutes > 5) {
        this.log('info', `[${sym}] ${minutes} মিনিট সিমুলেশন হিস্ট্রি তৈরি হচ্ছে...`);
        const gen = this.sim.generateHistory(def, minutes, nowMin * MINUTE);
        await this.persistCandles(gen);
        candles = await this.loadCandlesFromDb(sym, 700);
      }
    }
    const store = new PairCandleStore(sym);
    for (const c of candles) store.appendClosed(c);
    this.stores.set(sym, store);
    const lastPrice = candles.length ? candles[candles.length - 1].close : def.basePrice;
    this.sim.initPair(def, lastPrice);
  }

  private async loadCandlesFromDb(sym: string, take: number): Promise<Candle[]> {
    const rows = await db.candle.findMany({ where: { pair: sym }, orderBy: { ts: 'desc' }, take });
    return rows
      .map((r) => ({
        pair: r.pair,
        ts: r.ts.getTime(),
        open: r.open, high: r.high, low: r.low, close: r.close,
        ticks: r.ticks, upTicks: r.upTicks, downTicks: r.downTicks,
        lateFlip: r.lateFlip, lateMomentum: r.lateMomentum, flipCount: r.flipCount,
        source: r.source as FeedSource,
      }))
      .sort((a, b) => a.ts - b.ts);
  }

  private async persistCandles(cs: Candle[]) {
    if (!cs.length) return;
    try {
      // SQLite prisma has no skipDuplicates → filter out existing ids first
      const pairs = [...new Set(cs.map((c) => c.pair))];
      const from = Math.min(...cs.map((c) => c.ts));
      const to = Math.max(...cs.map((c) => c.ts));
      const existing = await db.candle.findMany({
        where: { pair: { in: pairs }, ts: { gte: new Date(from), lte: new Date(to) } },
        select: { id: true },
      });
      const existSet = new Set(existing.map((e) => e.id));
      const fresh = cs.filter((c) => !existSet.has(`${c.pair}:${c.ts}`));
      for (let i = 0; i < fresh.length; i += 500) {
        const chunk = fresh.slice(i, i + 500).map((c) => ({
          id: `${c.pair}:${c.ts}`,
          pair: c.pair,
          ts: new Date(c.ts),
          open: c.open, high: c.high, low: c.low, close: c.close,
          ticks: c.ticks, upTicks: c.upTicks, downTicks: c.downTicks,
          lateFlip: c.lateFlip, lateMomentum: c.lateMomentum, flipCount: c.flipCount,
          source: c.source,
        }));
        try {
          await db.candle.createMany({ data: chunk });
        } catch { /* ignore chunk-level races */ }
      }
    } catch {
      // DB lock/IO হলে এই ব্যাচ বাদ — ইঞ্জিন কখনো মরবে না, পরের মিনিটে আবার লেখা হবে
    }
  }

  // ---------------- live feed ----------------

  async startLive(token: string): Promise<{ ok: boolean; msg: string }> {
    this.stopLive();
    this.qxToken = token;
    this.tokenSource = token === (process.env.QX_TOKEN || '').trim() ? 'env' : 'db';
    try {
      await db.setting.update({ where: { id: 'main' }, data: { qxToken: token } });
    } catch { /* টোকেন সেভ ব্যর্থ হলেও লাইভ চেষ্টা চলবে */ }
    return new Promise((resolve) => {
      let settled = false;
      let wsEverConnected = false;
      let firstFailAt = 0;
      const finish = (ok: boolean, msg: string) => {
        if (settled) return;
        settled = true;
        clearInterval(probe);
        clearTimeout(hardTimeout);
        if (!ok) this.feed = 'SIM';
        resolve({ ok, msg });
      };
      this.qx = new QuotexClient(token, {
        onTick: (pair, price, t) => this.onLiveTick(pair, price, t),
        onCandles: (pair, candles) => this.onLiveCandles(pair, candles),
        onBalance: (b, cur) => { this.account.balance = b; this.account.currency = cur; },
        onStatus: (connected, reason) => {
          this.log(connected ? 'info' : 'warn', `Quotex সংযোগ: ${connected ? 'সক্রিয়' : reason}`);
          if (connected) {
            wsEverConnected = true;
            this.io?.emit('status', this.statusSnapshot());
          } else if (!wsEverConnected && !firstFailAt) {
            firstFailAt = Date.now();
          }
        },
        onRaw: (line) => this.pushRaw(line),
        onLog: (m) => this.log('info', m),
      });
      this.qx.connect(this.activePairs);
      // ⚡ দ্রুত উত্তর: প্রথম লাইভ টিক এলেই সফল; WS কখনো খুলেনি + ৩ সে. কেটে গেলে
      // দ্রুত-ব্যর্থ (স্পষ্ট কারণসহ); সর্বোচ্চ সীমা LIVE_TICK_TIMEOUT।
      // আগে সব কেসেই ১৫ সে. অপেক্ষা হতো — টোকেন-ক্লিকে টাইমআউট রেস তৈরি করত।
      const probe = setInterval(() => {
        if (this.qx?.receivingTicks) {
          finish(true, 'লাইভ টিক ডেটা চলছে');
        } else if (firstFailAt && Date.now() - firstFailAt > 3000) {
          finish(false, 'Quotex সার্ভারে পৌঁছানো যাচ্ছে না (টোকেন ভুল বা সার্ভার এই আইপি ব্লক করছে) — সিমুলেশনে আছি, ব্যাকগ্রাউন্ডে চেষ্টা চলবে');
        }
      }, 250);
      const hardTimeout = setTimeout(() => {
        if (this.qx?.receivingTicks) {
          finish(true, 'লাইভ টিক ডেটা চলছে');
        } else if (!wsEverConnected) {
          finish(false, 'Quotex সংযোগ পাওয়া যায়নি (নেটওয়ার্ক/আইপি ব্লক) — সিমুলেশনে আছি, ব্যাকগ্রাউন্ডে চেষ্টা চলবে');
        } else {
          finish(false, 'সংযোগ হয়েছে কিন্তু টিক ডেটা আসেনি — সিমুলেশনে ফিরে গেছে (টোকেন/পেয়ার চেক করুন)');
        }
      }, LIVE_TICK_TIMEOUT);
    });
  }

  stopLive() {
    if (this.qx) {
      this.qx.close();
      this.qx = null;
    }
    this.feed = 'SIM';
  }

  private onLiveTick(pair: string, price: number, t: number) {
    if (!this.stores.has(pair)) return;
    this.lastLiveTickAt = t;
    if (this.feed !== 'LIVE') {
      this.feed = 'LIVE';
      this.log('info', `লাইভ Quotex টিক ডেটা সক্রিয় হলো (${pair})`);
      this.io?.emit('status', this.statusSnapshot());
      // re-anchor sim to live price to avoid future jumps
      this.sim.initPair(getPairDef(pair), price);
    }
    this.onTick(pair, price, t, 'LIVE');
  }

  private onLiveCandles(pair: string, candles: { t: number; o: number; h: number; l: number; c: number }[]) {
    const store = this.stores.get(pair);
    if (!store || !candles.length) return;
    this.log('info', `[${pair}] Quotex থেকে ${candles.length}টি হিস্টোরিক্যাল ক্যান্ডেল পাওয়া গেছে`);
    const mapped: Candle[] = candles
      .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c))
      .map((c) => ({
        pair, ts: Math.floor(c.t / MINUTE) * MINUTE,
        open: c.o, high: Math.max(c.h, c.o, c.c), low: Math.min(c.l, c.o, c.c), close: c.c,
        ticks: 0, upTicks: 0, downTicks: 0, lateFlip: 0, lateMomentum: 0, flipCount: 0,
        source: 'LIVE' as const,
      }));
    void this.persistCandles(mapped).catch(() => {});
    // merge into memory (replace sim candles in overlapping range)
    const liveFrom = mapped.length ? mapped[0].ts : 0;
    store.candles = store.candles.filter((c) => c.ts < liveFrom || c.source === 'LIVE');
    for (const c of mapped) if (!store.candles.some((x) => x.ts === c.ts)) store.appendClosed(c);
    store.candles.sort((a, b) => a.ts - b.ts);
  }

  // ---------------- tick & minute pipeline ----------------

  private simTickLoop() {
    const now = Date.now();
    const liveActive = this.feed === 'LIVE' && this.qx?.connected && now - this.lastLiveTickAt < LIVE_TICK_TIMEOUT;
    if (liveActive) return; // live feed owns the ticks
    if (this.feed === 'LIVE' && now - this.lastLiveTickAt >= LIVE_TICK_TIMEOUT) {
      this.feed = 'SIM';
      this.log('warn', 'লাইভ টিক বন্ধ হয়ে গেছে — সিমুলেশন ফিড পুনরায় চালু (দাম ধারাবাহিক রাখা হয়েছে)');
      this.io?.emit('status', this.statusSnapshot());
    }
    for (const sym of this.activePairs) {
      const t = this.sim.nextTick(sym, now);
      if (t) this.onTick(sym, t.price, t.t, 'SIM');
    }
  }

  private onTick(pair: string, price: number, t: number, source: FeedSource) {
    const store = this.stores.get(pair);
    if (!store) return;
    const minute = Math.floor(t / MINUTE) * MINUTE;
    if (!store.running || store.running.ts !== minute) {
      if (store.running && store.running.ts > minute) return;
      const openRef = store.running ? store.running.last : store.candles.length ? store.candles[store.candles.length - 1].close : price;
      store.startRunning(minute, openRef);
    }
    store.running!.onTick({ t, price });
  }

  private minuteWatcher() {
    const now = Date.now();
    const cur = Math.floor(now / MINUTE);
    if (cur <= this.lastMinute) return;
    const closedMinute = this.lastMinute;
    this.lastMinute = cur;
    for (const sym of this.activePairs) {
      const store = this.stores.get(sym);
      if (!store) continue;
      const runTs = store.running?.ts ?? 0;
      if (store.running && runTs === closedMinute * MINUTE) {
        this.closeCandle(sym, store, now);
      } else if (store.running && runTs < closedMinute * MINUTE) {
        // stale candle (missed ticks) — close it too
        this.closeCandle(sym, store, now);
      }
      // start the fresh candle at current minute
      const openRef = store.candles.length ? store.candles[store.candles.length - 1].close : getPairDef(sym).basePrice;
      if (!store.running || store.running.ts !== cur * MINUTE) {
        store.startRunning(cur * MINUTE, openRef);
      }
    }
  }

  private closeCandle(sym: string, store: PairCandleStore, now: number) {
    const source: FeedSource = this.feed;
    const candle = store.closeCurrent(now, source);
    if (!candle) return;
    void this.persistCandles([candle]).catch(() => {});

    // 1) resolve previous pending signal with THIS candle's close
    const pend = this.pending.get(sym);
    if (pend && pend.ts === candle.ts - MINUTE) {
      pend.closePrice = candle.close;
      pend.result =
        candle.close === pend.entryPrice
          ? 'TIE'
          : (pend.direction === 'CALL' ? (candle.close > pend.entryPrice ? 'WIN' : 'LOSS') : candle.close < pend.entryPrice ? 'WIN' : 'LOSS');
      this.pending.delete(sym);
      void db.signal.update({ where: { id: pend.id }, data: { closePrice: candle.close, result: pend.result } }).catch(() => {});
      this.io?.emit('signal:resolved', pend);
      this.log('info', `[${sym}] ${pend.direction} সিগন্যাল ${pend.result === 'WIN' ? 'উইন ✓' : pend.result === 'LOSS' ? 'লস ✗' : 'টাই'} (${pend.confidence}%)`);
    }

    // 2) evaluate new signal at FULL candle close (the user's core requirement)
    const def = getPairDef(sym);
    const ev = evaluateSignal({ candles: store.candles, last: store.candles.length - 1, def });
    if (ev && ev.score >= this.minConfidence) {
      const rec: SignalRec = {
        id: `sig_${sym}_${candle.ts}`,
        pair: sym,
        ts: candle.ts + MINUTE, // trade entry = next minute open
        direction: ev.direction,
        confidence: ev.score,
        score: ev.score,
        reasons: ev.reasons,
        entryPrice: candle.close,
        closePrice: null,
        result: 'PENDING',
        source,
      };
      this.pending.set(sym, rec);
      this.signalsGenerated += 1;
      void db.signal
        .create({
          data: {
            id: rec.id, pair: sym, ts: new Date(rec.ts), direction: rec.direction,
            confidence: rec.confidence, score: rec.score, reasons: JSON.stringify(rec.reasons),
            entryPrice: rec.entryPrice, result: 'PENDING', source,
          },
        })
        .catch(() => {});
      this.io?.emit('signal:new', rec);
      this.log('info', `[${sym}] নতুন সিগন্যাল: ${rec.direction} @ ${rec.entryPrice.toFixed(def.digits)} (${ev.score}% কনফিডেন্স)`);
    }

    this.io?.emit('candle:closed', { pair: sym, candle });
  }

  // ---------------- broadcast & snapshots ----------------

  private broadcast() {
    if (!this.io) return;
    this.io.emit('market', this.snapshot());
  }

  statusSnapshot(): EngineStatus {
    return {
      mode: this.feed,
      desiredMode: this.desiredMode,
      liveConnected: !!this.qx?.connected && this.feed === 'LIVE',
      socketClients: this.io?.sockets.sockets.size ?? 0,
      serverTime: Date.now(),
      accountBalance: this.account.balance,
      currency: this.account.currency,
      login: this.account.login,
      activePairs: [...this.activePairs],
      minConfidence: this.minConfidence,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      historyMinutes: HISTORY_MINUTES,
    };
  }

  snapshot(): MarketSnapshot {
    const now = Date.now();
    const pairs: PairMarketState[] = this.activePairs.map((sym) => {
      const def = getPairDef(sym);
      const store = this.stores.get(sym)!;
      const run = store.running;
      const lastClosed = store.candles.length ? store.candles[store.candles.length - 1] : null;
      const price = run?.last ?? lastClosed?.close ?? def.basePrice;
      const zones = detectZones(store.candles, def.pip, price);
      const pip = def.pip;

      let running: RunningCandleState;
      if (run) {
        const near = zones
          .map((z) => ({ z, d: (price - z.price) / pip }))
          .sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
        const live = run.toPseudoCandle(this.feed);
        const preview = previewRunningScore(store.candles, live, def);
        running = {
          pair: sym,
          ts: run.ts,
          open: run.open, high: run.high, low: run.low, last: run.last,
          secondsLeft: 60 - Math.floor(((now - run.ts) % MINUTE) / 1000),
          color: run.color,
          ticks: run.ticks, upTicks: run.upTicks, downTicks: run.downTicks,
          tickImbalance: run.ticks ? Number(((run.upTicks - run.downTicks) / run.ticks).toFixed(2)) : 0,
          momentum5s: run.momentum(5, pip, now),
          momentum10s: run.momentum(10, pip, now),
          colorFlips: run.flips.length,
          lastFlipAtSec: run.flips.length ? run.flips[run.flips.length - 1] : -1,
          upperWickPips: Number(((run.high - Math.max(run.open, run.last)) / pip).toFixed(1)),
          lowerWickPips: Number(((Math.min(run.open, run.last) - run.low) / pip).toFixed(1)),
          nearZone: near && Math.abs(near.d) < 30
            ? { side: near.z.side, price: near.z.price, distancePips: Number(near.d.toFixed(1)), strength: near.z.strength }
            : null,
          liveScore: preview ? { direction: preview.direction, score: preview.score, reasons: preview.reasons } : null,
        };
      } else {
        running = {
          pair: sym, ts: now, open: price, high: price, low: price, last: price, secondsLeft: 0,
          color: 'FLAT', ticks: 0, upTicks: 0, downTicks: 0, tickImbalance: 0, momentum5s: 0, momentum10s: 0,
          colorFlips: 0, lastFlipAtSec: -1, upperWickPips: 0, lowerWickPips: 0, nearZone: null, liveScore: null,
        };
      }

      return {
        pair: sym, name: def.name, digits: def.digits, price,
        changePips1m: lastClosed ? Number(((lastClosed.close - lastClosed.open) / pip).toFixed(1)) : 0,
        running, lastClosed,
      };
    });

    return {
      status: this.statusSnapshot(),
      pairs,
      pendingSignals: [...this.pending.values()],
    };
  }

  getHistory(pair: string, limit = 180): Candle[] {
    const store = this.stores.get(pair);
    if (!store) return [];
    const closed = store.candles.slice(-limit);
    if (store.running) {
      const run = store.running;
      closed.push({
        pair, ts: run.ts, open: run.open, high: run.high, low: run.low, close: run.last,
        ticks: run.ticks, upTicks: run.upTicks, downTicks: run.downTicks,
        lateFlip: 0, lateMomentum: 0, flipCount: run.flips.length, source: this.feed,
      });
    }
    return closed;
  }

  // ---------------- signals & stats (DB) ----------------

  async getSignals(f: SignalFilter): Promise<SignalRec[]> {
    const where: any = {};
    if (f.pair && f.pair !== 'ALL') where.pair = f.pair;
    if (f.direction && f.direction !== 'ALL') where.direction = f.direction;
    const sources = f.source && f.source.length ? f.source : ['LIVE', 'SIM'];
    where.source = { in: sources };
    if (f.periodH && f.periodH > 0) where.ts = { gte: new Date(Date.now() - f.periodH * 3600000) };
    const rows = await db.signal.findMany({ where, orderBy: { ts: 'desc' }, take: Math.min(f.limit ?? 100, 500) });
    return rows.map((r) => ({
      id: r.id, pair: r.pair, ts: r.ts.getTime(), direction: r.direction as any,
      confidence: r.confidence, score: r.score, reasons: JSON.parse(r.reasons || '[]'),
      entryPrice: r.entryPrice, closePrice: r.closePrice, result: r.result as any, source: r.source as any,
    }));
  }

  async getStats(f: { periodH?: number; source?: string[] }): Promise<{ overall: StatsBlock; perPair: PairStat[] }> {
    const where: any = {};
    const sources = f.source && f.source.length ? f.source : ['LIVE', 'SIM'];
    where.source = { in: sources };
    if (f.periodH && f.periodH > 0) where.ts = { gte: new Date(Date.now() - f.periodH * 3600000) };
    const rows = await db.signal.findMany({ where, orderBy: { ts: 'desc' }, take: 3000 });

    const mk = (list: typeof rows): StatsBlock => {
      const wins = list.filter((r) => r.result === 'WIN').length;
      const losses = list.filter((r) => r.result === 'LOSS').length;
      const ties = list.filter((r) => r.result === 'TIE').length;
      const pending = list.filter((r) => r.result === 'PENDING').length;
      const call = list.filter((r) => r.direction === 'CALL');
      const put = list.filter((r) => r.direction === 'PUT');
      const cW = call.filter((r) => r.result === 'WIN').length;
      const pW = put.filter((r) => r.result === 'WIN').length;
      // streak over chronological order
      const chrono = [...list].sort((a, b) => a.ts.getTime() - b.ts.getTime()).filter((r) => r.result === 'WIN' || r.result === 'LOSS');
      let cur = 0, maxW = 0, maxL = 0, curType: 'W' | 'L' | null = null;
      for (const r of chrono) {
        const t = r.result === 'WIN' ? 'W' : 'L';
        if (t === curType) cur += 1;
        else { curType = t; cur = 1; }
        if (t === 'W') maxW = Math.max(maxW, cur);
        else maxL = Math.max(maxL, cur);
      }
      const decided = wins + losses;
      return {
        total: list.length, wins, losses, ties, pending,
        winRate: decided ? Math.round((wins / decided) * 100) : 0,
        call: { total: call.length, wins: cW, losses: call.filter((r) => r.result === 'LOSS').length, ties: call.filter((r) => r.result === 'TIE').length, winRate: cW + call.filter((r) => r.result === 'LOSS').length ? Math.round((cW / (cW + call.filter((r) => r.result === 'LOSS').length)) * 100) : 0 },
        put: { total: put.length, wins: pW, losses: put.filter((r) => r.result === 'LOSS').length, ties: put.filter((r) => r.result === 'TIE').length, winRate: pW + put.filter((r) => r.result === 'LOSS').length ? Math.round((pW / (pW + put.filter((r) => r.result === 'LOSS').length)) * 100) : 0 },
        streak: { current: cur, maxWin: maxW, maxLoss: maxL, currentType: curType },
      };
    };

    const overall = mk(rows);
    const perPair: PairStat[] = this.activePairs.map((sym) => {
      const s = mk(rows.filter((r) => r.pair === sym));
      return { ...s, pair: sym };
    });
    return { overall, perPair };
  }

  // ---------------- settings ----------------

  async saveSettings(patch: { pairs?: string[]; minConfidence?: number; mode?: string }): Promise<{ ok: boolean; msg: string }> {
    if (patch.minConfidence != null) {
      this.minConfidence = Math.max(50, Math.min(95, Math.round(patch.minConfidence)));
    }
    if (patch.mode && ['auto', 'live', 'simulation'].includes(patch.mode)) {
      this.desiredMode = patch.mode as any;
      if (patch.mode === 'simulation') this.stopLive();
    }
    if (patch.pairs && patch.pairs.length) {
      const valid = patch.pairs.filter((p) => ALL_PAIRS.some((d) => d.symbol === p));
      for (const sym of valid) {
        if (!this.stores.has(sym)) {
          this.activePairs.push(sym);
          await this.initPair(sym);
          const store = this.stores.get(sym)!;
          store.startRunning(Math.floor(Date.now() / MINUTE) * MINUTE, store.candles.length ? store.candles[store.candles.length - 1].close : getPairDef(sym).basePrice);
          this.log('info', `[${sym}] পেয়ার সক্রিয় করা হলো`);
        }
      }
      for (const sym of [...this.stores.keys()]) {
        if (!valid.includes(sym)) {
          this.stores.delete(sym);
          this.sim.removePair(sym);
          this.activePairs = this.activePairs.filter((p) => p !== sym);
          this.pending.delete(sym);
          this.log('info', `[${sym}] পেয়ার বন্ধ করা হলো`);
        }
      }
      if (this.qx) this.qx.connect(this.activePairs);
    }
    await db.setting.update({
      where: { id: 'main' },
      data: {
        minConfidence: this.minConfidence,
        mode: this.desiredMode,
        pairs: this.activePairs.join(','),
      },
    });
    this.io?.emit('status', this.statusSnapshot());
    return { ok: true, msg: 'সেটিংস সংরক্ষিত' };
  }

  getTokenMasked(): string {
    if (!this.qxToken) return '';
    const t = this.qxToken;
    return t.length <= 10 ? '••••' : `${t.slice(0, 6)}••••••${t.slice(-4)}`;
  }

  getSettings() {
    return {
      tokenMasked: this.getTokenMasked(),
      tokenSource: this.tokenSource,
      mode: this.desiredMode,
      minConfidence: this.minConfidence,
      pairs: [...this.activePairs],
      allPairs: ALL_PAIRS.map((p) => ({ symbol: p.symbol, name: p.name })),
    };
  }

  // ---------------- backtest ----------------

  async runBacktest(): Promise<BTSummary> {
    const t0 = Date.now();
    await db.signal.deleteMany({ where: { source: 'BACKTEST' } });
    const perPair: BTSummary['perPair'] = [];
    const allSignals: BTSignal[] = [];
    let candlesTested = 0;
    let from = Infinity, to = -Infinity;

    for (const sym of this.activePairs) {
      const def = getPairDef(sym);
      // use up to 2 days of candles from the DB (more robust than RAM store)
      const rows = await db.candle.findMany({ where: { pair: sym }, orderBy: { ts: 'desc' }, take: 2000 });
      const hist = rows
        .map((r) => ({
          pair: r.pair, ts: r.ts.getTime(),
          open: r.open, high: r.high, low: r.low, close: r.close,
          ticks: r.ticks, upTicks: r.upTicks, downTicks: r.downTicks,
          lateFlip: r.lateFlip, lateMomentum: r.lateMomentum, flipCount: r.flipCount,
          source: r.source as FeedSource,
        }))
        .sort((a, b) => a.ts - b.ts);
      if (hist.length < 60) continue;
      const { signals, result } = backtestPair(sym, hist, def, this.minConfidence);
      perPair.push(result);
      allSignals.push(...signals);
      candlesTested += hist.length;
      from = Math.min(from, hist[0].ts);
      to = Math.max(to, hist[hist.length - 1].ts);

      // persist backtest signals (cap per pair to keep DB light)
      const cap = signals.slice(-400);
      for (let i = 0; i < cap.length; i += 250) {
        const chunk = cap.slice(i, i + 250).map((s) => ({
          pair: s.pair, ts: new Date(s.ts), direction: s.direction, confidence: s.score, score: s.score,
          reasons: JSON.stringify(s.reasons), entryPrice: s.entryPrice, closePrice: s.closePrice,
          result: s.result, source: 'BACKTEST', backtestId: 'bt',
        }));
        try { await db.signal.createMany({ data: chunk }); } catch { /* noop */ }
      }
    }

    const id = `bt_${Date.now()}`;
    const summary = aggregateBacktest(id, this.minConfidence, perPair, allSignals, candlesTested, from === Infinity ? 0 : from, to === -Infinity ? 0 : to);
    await db.setting.update({ where: { id: 'main' }, data: { lastBacktest: JSON.stringify(summary) } });
    this.log('info', `ব্যাকটেস্ট সম্পন্ন ${((Date.now() - t0) / 1000).toFixed(1)}s — ${summary.overall.signals} সিগন্যাল, উইন রেট ${summary.overall.winRate}%`);
    return summary;
  }

  async getLastBacktest(): Promise<BTSummary | null> {
    const s = await db.setting.findUnique({ where: { id: 'main' } });
    if (!s?.lastBacktest) return null;
    try { return JSON.parse(s.lastBacktest); } catch { return null; }
  }

  // ---------------- logs ----------------

  log(level: LogLine['level'], msg: string) {
    this.logs.push({ t: Date.now(), level, msg });
    if (this.logs.length > 250) this.logs.splice(0, this.logs.length - 250);
    this.io?.emit('log', this.logs[this.logs.length - 1]);
    console.log(`[qx-engine] ${msg}`);
  }

  pushRaw(line: string) {
    this.rawLog.push(line);
    if (this.rawLog.length > 120) this.rawLog.splice(0, this.rawLog.length - 120);
  }

  getLogs() { return this.logs.slice(-100); }
  getRawLog() { return this.rawLog.slice(-60); }
}
