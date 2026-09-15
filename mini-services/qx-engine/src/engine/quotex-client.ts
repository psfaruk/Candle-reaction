import WebSocket from 'ws';

// ============ Quotex (qxbroker) WebSocket Client ============
// প্রোটোকল: raw socket.io (engine.io EIO=3) over WS @ ws2.qxbroker.com
// সোর্স: pyquotex + ChipaDevTeam/QuotexAPI + A11ksa/API-Quotex + লাইভ প্যাকেট ক্যাপচার।
//
// ফ্লো:
//   WS open → ← 0{sid} → → 40 → ← 40 → (1.2s) → 42["authorization",{session,isDemo,tournamentId}]
//     ├─ ← 42["s_authorization"] → সাবস্ক্রাইব (পেসড): instruments/update + depth/follow + history/load
//     └─ ← 42["authorization/reject"] → সার্ভার সকেট বন্ধ করে → আর রিকানেক্ট নয় (টোকেন নতুন লাগবে)
//
// ডেটা ফরম্যাট:
//   টিক: 42[["EURUSD_otc",1698238932,1.08432,1]] অথবা binary "quotes/stream" [[asset,ts,price],...]
//   ক্যান্ডেল হিস্ট্রি: 451-["history/list/v2",{_placeholder}] + binary {asset,period,history:{candles}}
//   লাইভ ক্যান্ডেল: 42["candle-generated",{asset,period,open,high,low,close,time}]
//   ব্যালেন্স: 42["balance",{liveBalance,demoBalance}]

export interface QuotexEvents {
  onTick: (pair: string, price: number, t: number) => void;
  onCandles: (pair: string, candles: { t: number; o: number; h: number; l: number; c: number }[]) => void;
  onBalance: (balance: number, currency: string | null) => void;
  onStatus: (connected: boolean, reason: string) => void;
  onRaw: (line: string) => void;
  onLog: (msg: string) => void;
}

const WS_URL = process.env.QX_WS_URL || 'wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type AuthState = 'idle' | 'pending' | 'ok' | 'rejected';

/** ইউজার যা-ই পেস্ট করুক — সেশন টোকেন + isDemo বের করে দেয় */
export function parseQxToken(input: string): { session: string; isDemo: number } {
  let s = (input || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return { session: '', isDemo: 1 };
  // ফুল ফ্রেম: 42["authorization",{"session":"...","isDemo":1,...}] বা ["authorization",{...}]
  const frameBody = s.startsWith('42') ? s.slice(2) : s.startsWith('[') ? s : null;
  if (frameBody) {
    try {
      const arr = JSON.parse(frameBody);
      if (Array.isArray(arr) && arr[0] === 'authorization' && arr[1] && typeof arr[1] === 'object' && arr[1].session) {
        return { session: String(arr[1].session), isDemo: Number(arr[1].isDemo ?? 1) };
      }
    } catch { /* নিচে চলবে */ }
  }
  // JSON: {"session":"..."} / {"ssid":"..."}
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      const sess = o?.session || o?.ssid || o?.token;
      if (sess) return { session: String(sess), isDemo: Number(o.isDemo ?? 1) };
    } catch { /* নিচে চলবে */ }
  }
  // কুকি-স্টাইল: q9securid=XXX (সেমিকোলনসহ পুরো হেডারও হতে পারে)
  const m = s.match(/(?:q9securid|ssid|session|token)\s*=\s*"?([A-Za-z0-9_.~:-]+)/i);
  if (m) s = m[1];
  // "123456:secret" ফরম্যাট → কোলনের আগে পূর্ণ সংখ্যা থাকলে সেটাই ssid
  if (s.includes(':')) {
    const head = s.split(':')[0];
    if (head && /^\d+$/.test(head)) s = head;
  }
  return { session: s, isDemo: 1 };
}

interface QxPair {
  base: string;      // ইঞ্জিন পেয়ার (EURUSD)
  qAsset: string;    // Quotex সিম্বল (EURUSD_otc)
}

export class QuotexClient {
  private ws: WebSocket | null = null;
  private ev: QuotexEvents;
  private auth = { session: '', isDemo: 1 };
  private pairs: QxPair[] = [];
  private pairBySymbol = new Map<string, QxPair>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private subTimers: NodeJS.Timeout[] = [];
  private attempts = 0;
  private gotTicks = false;
  private pendingBinaryEvent: string | null = null;
  private instrumentsSeen = false;

  /** 'idle' → 'pending' → 'ok' | 'rejected' */
  authState: AuthState = 'idle';

  constructor(token: string, ev: QuotexEvents) {
    this.auth = parseQxToken(token);
    this.ev = ev;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  get receivingTicks() {
    return this.gotTicks;
  }

  connect(pairs: string[]) {
    this.closed = false;
    this.pairs = pairs.map((p) => {
      const base = p.replace(/_otc$/i, '').toUpperCase();
      return { base, qAsset: `${base}_otc` };
    });
    // ফলব্যাক: _otc না থাকলে রিয়েল সিম্বলও ম্যাপে রাখি
    this.pairBySymbol = new Map();
    for (const p of this.pairs) {
      this.pairBySymbol.set(p.qAsset, p);
      if (!this.pairBySymbol.has(p.base)) this.pairBySymbol.set(p.base, p);
    }
    this.open();
  }

  // ---------------- connection ----------------

  private open() {
    if (this.closed) return;
    this.cleanupSocket();
    this.authState = this.authState === 'rejected' ? 'rejected' : 'idle';
    this.ev.onLog(`Quotex WS সংযোগ (ws2.qxbroker.com)… চেষ্টা ${this.attempts + 1}`);
    try {
      this.ws = new WebSocket(WS_URL, {
        headers: {
          'User-Agent': UA,
          Origin: 'https://qxbroker.com',
          ...(this.auth.session ? { Cookie: `q9securid=${this.auth.session};` } : {}),
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        handshakeTimeout: 12000,
      });
    } catch (e: any) {
      this.ev.onStatus(false, `connect error: ${e?.message ?? e}`);
      this.scheduleReconnect();
      return;
    }
    this.ws.on('open', () => {
      this.attempts = 0;
      this.ev.onRaw('→ [WS OPEN]');
    });
    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      try {
        if (isBinary) this.handleBinary(data.toString());
        else this.handleText(data.toString());
      } catch (e: any) {
        this.ev.onLog(`মেসেজ হ্যান্ডলিং ত্রুটি: ${e?.message ?? e}`);
      }
    });
    this.ws.on('error', (e: Error) => {
      this.ev.onLog(`WS ত্রুটি: ${e.message}`);
    });
    this.ws.on('close', (code: number) => {
      this.ev.onRaw(`← [WS CLOSE ${code}]`);
      if (this.authState === 'ok') {
        this.ev.onStatus(false, `সংযোগ বিচ্ছিন্ন (${code}) — পুনঃসংযোগ হচ্ছে`);
      }
      if (this.closed) return;
      if (this.authState === 'rejected') return; // খারাপ টোকেন দিয়ে হ্যামার করব না
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.closed || this.authState === 'rejected') return;
    this.cleanupSocket();
    this.authState = 'idle'; // নতুন সকেটে নতুন করে অথ হবে
    this.attempts += 1;
    const delay = Math.min(30000, 3000 * this.attempts);
    this.ev.onLog(`${Math.round(delay / 1000)}s পরে পুনঃসংযোগ…`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private cleanupSocket() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    for (const t of this.subTimers) clearTimeout(t);
    this.subTimers = [];
    this.pendingBinaryEvent = null;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch { /* noop */ }
    }
    this.ws = null;
  }

  close() {
    this.closed = true;
    this.cleanupSocket();
    this.ev.onLog('Quotex WS বন্ধ করা হয়েছে।');
  }

  private send(raw: string) {
    if (this.connected && this.ws) {
      this.ev.onRaw(`→ ${raw.slice(0, 160)}`);
      try { this.ws.send(raw); } catch { /* noop */ }
    }
  }

  // ---------------- protocol ----------------

  private handleText(msg: string) {
    if (msg.length < 2) return;
    if (msg.length < 300) this.ev.onRaw(`← ${msg.slice(0, 160)}`);

    // engine.io handshake → নেমস্পেস কানেক্ট
    if (msg.startsWith('0{')) { this.send('40'); return; }
    // socket.io connected (bare '40' বা '40{"sid":...}')
    if (msg.startsWith('40')) {
      if (this.authState !== 'idle') return; // ডুপ্লিকেট গার্ড (রিকানেক্টে idle এ রিসেট হয়)
      this.authState = 'pending';
      this.ev.onLog('socket.io সংযোগ হয়েছে — অথেন্টিকেশন পাঠানো হচ্ছে…');
      // পেসিং গুরুত্বপূর্ণ: সাথে সাথে পাঠালে সার্ভার কানেকশন কেটে দেয়
      this.authTimer = setTimeout(() => {
        this.send(`42${JSON.stringify(['authorization', {
          session: this.auth.session,
          isDemo: this.auth.isDemo,
          tournamentId: 0,
          isFastHistory: true,
        }])}`);
      }, 1200);
      return;
    }
    if (msg === '2' || msg === '2probe') { this.send(msg === '2' ? '3' : '3probe'); return; }
    if (msg.startsWith('3')) return; // pong
    if (msg.startsWith('41')) return; // socket.io disconnect

    // binary প্রিফেস হেডার: 451-["event",{"_placeholder":true}] / 51-["event",…]
    // → পরের binary ফ্রেমে এই ইভেন্টের পেলোড আসে
    const mHdr = msg.match(/^\d+-\["([^"]+)"/);
    if (mHdr) {
      this.pendingBinaryEvent = mHdr[1];
      this.ev.onRaw(`← ${msg.slice(0, 140)}`);
      return;
    }

    if (msg.startsWith('42')) {
      const body = msg.slice(2);
      try {
        const arr = JSON.parse(body);
        if (Array.isArray(arr)) {
          const head = arr[0];
          if (typeof head === 'string') { this.handleEvent(head, arr[1]); return; }
          if (Array.isArray(head)) { this.handleQuoteBatch(arr as unknown[][]); return; }
        }
      } catch { /* noop */ }
      return;
    }
  }

  private handleBinary(raw: string) {
    // EIO=3: binary টেক্সট পেলোড '\x04' প্রিফিক্সসহ আসে
    const body = raw.charCodeAt(0) === 0x04 ? raw.slice(1) : raw;
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      this.ev.onRaw(`← [bin non-JSON ${body.length}b]`);
      return;
    }
    const evt = this.pendingBinaryEvent;
    this.pendingBinaryEvent = null;
    if (evt) {
      this.ev.onRaw(`← [bin:${evt}] ${body.slice(0, 140)}`);
      this.handleEvent(evt, payload);
      return;
    }
    // হেডারহীন binary — শেপ থেকে ইনফার করি
    if (Array.isArray(payload) && payload.length && Array.isArray(payload[0])) {
      const f = payload[0];
      if (typeof f[0] === 'string' && typeof f[2] === 'number') this.handleEvent('quotes/stream', payload);
      else if (typeof f[0] === 'number' && typeof f[1] === 'string') this.handleEvent('instruments/list', payload);
      return;
    }
    if (payload && typeof payload === 'object') {
      if (payload.history || payload.candles) this.handleEvent('history/list/v2', payload);
      else if (payload.asset && (payload.open != null || payload.close != null)) this.handleEvent('candle-generated', payload);
      else if (payload.liveBalance != null || payload.demoBalance != null) this.handleEvent('balance', payload);
    }
  }

  // ---------------- events ----------------

  private handleEvent(evt: string, data: any) {
    switch (evt) {
      case 's_authorization':
      case 'success-login': {
        if (this.authState !== 'ok') {
          this.authState = 'ok';
          this.ev.onLog('✅ Quotex অথেন্টিকেশন সফল — পেয়ার সাবস্ক্রিপশন চালু হচ্ছে…');
        }
        this.ev.onStatus(true, 'authorized');
        this.pacedSubscribe();
        return;
      }
      case 'authorization/reject': {
        this.authState = 'rejected';
        this.ev.onStatus(false, 'rejected');
        this.ev.onLog('❌ টোকেন প্রত্যাখ্যাত (authorization/reject) — নতুন টোকেন দরকার');
        try { this.ws?.close(); } catch { /* noop */ }
        return;
      }
      case 'balance':
      case 's_balance': {
        const b = data?.demoBalance ?? data?.liveBalance ?? data?.balance;
        const num = Number(b);
        if (Number.isFinite(num)) this.ev.onBalance(num, data?.currency ?? null);
        return;
      }
      case 'quotes/stream': {
        if (Array.isArray(data)) this.handleQuoteBatch(data);
        return;
      }
      case 'depth/change': {
        // [[asset, lastDigits]] — লাইভনেস সিগন্যাল হিসেবে ব্যবহার (পুরো দাম quotes এ আসে)
        if (!this.gotTicks && Array.isArray(data)) {
          const sym = data[0]?.[0];
          const p = typeof sym === 'string' ? this.pairBySymbol.get(sym.toUpperCase()) : null;
          if (p) this.ev.onLog(`[${sym}] মার্কেট স্ট্রিম জীবিত (depth) — সম্পূর্ণ টিকের অপেক্ষায়…`);
        }
        return;
      }
      case 'instruments/list': {
        if (!this.instrumentsSeen && Array.isArray(data)) {
          this.instrumentsSeen = true;
          const fx = data.filter((r: any) => typeof r?.[1] === 'string' && this.pairBySymbol.has(r[1]));
          this.ev.onLog(`Quotex ইনস্ট্রুমেন্ট লিস্ট পাওয়া গেছে (${data.length} অ্যাসেট, আমাদের পেয়ার ${fx.length}টি মিলেছে)`);
        }
        return;
      }
      case 'candle-generated':
      case 'depth': {
        // লাইভ (চলমান) ক্যান্ডেল আপডেট — close দামটা টিক হিসেবে ফিড করি
        const sym = String(data?.asset ?? '');
        const p = this.pairBySymbol.get(sym.toUpperCase());
        const close = Number(data?.close ?? data?.c);
        const t = Number(data?.time ?? Date.now() / 1000);
        if (p && Number.isFinite(close) && close > 0) {
          const tMs = t > 1e12 ? t : t > 1e9 ? t * 1000 : Date.now();
          this.emitTick(p, close, tMs);
        }
        return;
      }
      case 'history/list/v2':
      case 'history/load':
      case 'success-instruments-candles':
      case 'instruments-candles':
      case 'chart_notification/get': {
        this.handleHistoryPayload(data);
        return;
      }
      default:
        return;
    }
  }

  /** 42[["EURUSD_otc",1698238932,1.08432,1], ...] */
  private handleQuoteBatch(rows: unknown[][]) {
    for (const q of rows) {
      if (!Array.isArray(q)) continue;
      const sym = q[0];
      const t = Number(q[1]);
      const price = Number(q[2]);
      if (typeof sym !== 'string' || !Number.isFinite(price) || price <= 0) continue;
      const p = this.pairBySymbol.get(sym.toUpperCase());
      if (!p) continue;
      const tMs = t > 1e12 ? t : t > 1e9 ? t * 1000 : Date.now();
      this.emitTick(p, price, tMs);
    }
  }

  /** {asset, period, history:{candles|...}} / {candles:[...]} / {history:{asset:{candles:[...]}}} */
  private handleHistoryPayload(data: any) {
    if (!data || typeof data !== 'object') return;
    const assetRaw = String(data.asset ?? data.symbol ?? '');
    const p = assetRaw ? this.pairBySymbol.get(assetRaw.toUpperCase()) : null;

    // ক্যান্ডেল অ্যারে বের করি — সব পরিচিত শেপ থেকে
    let rawCandles: any[] | null = null;
    const hist = data.history ?? data.candles ?? data.data;
    if (Array.isArray(hist)) rawCandles = hist;
    else if (hist && typeof hist === 'object') {
      if (Array.isArray(hist.candles)) rawCandles = hist.candles;
      else if (hist.data && Array.isArray(hist.data.candles)) rawCandles = hist.data.candles;
      else {
        // {history: {"EURUSD_otc": {candles: [...]}}} শেপ
        for (const k of Object.keys(hist)) {
          const v = (hist as any)[k];
          if (v && Array.isArray(v.candles)) { rawCandles = v.candles; break; }
        }
      }
    }
    if (!rawCandles || !rawCandles.length) return;

    const candles: { t: number; o: number; h: number; l: number; c: number }[] = [];
    for (const rc of rawCandles) {
      let t = 0, o = NaN, h = NaN, l = NaN, c = NaN;
      if (Array.isArray(rc)) {
        // [time, open, close, high, low] বা [time, open, high, low, close] — উভয়ই ট্রাই
        t = Number(rc[0]);
        o = Number(rc[1]);
        if (rc.length >= 5) {
          c = Number(rc[2]); h = Number(rc[3]); l = Number(rc[4]);
          if (!(Number.isFinite(h) && Number.isFinite(l))) { h = Number(rc[3]); l = Number(rc[4]); }
        } else if (rc.length >= 3) {
          c = Number(rc[2]); h = Math.max(o, c); l = Math.min(o, c);
        }
      } else if (rc && typeof rc === 'object') {
        t = Number(rc.time ?? rc.t ?? rc.timestamp ?? rc.created_at ?? NaN);
        o = Number(rc.open ?? rc.o);
        h = Number(rc.high ?? rc.h);
        l = Number(rc.low ?? rc.l);
        c = Number(rc.close ?? rc.c);
        if (!Number.isFinite(t) && typeof rc.time === 'string') {
          const parsed = Date.parse(String(rc.time).replace(' ', 'T') + (String(rc.time).endsWith('Z') ? '' : 'Z'));
          if (Number.isFinite(parsed)) t = parsed / 1000;
        }
      }
      if (!Number.isFinite(t)) continue;
      const tMs = t > 1e12 ? t : t * 1000;
      if (![o, h, l, c].every(Number.isFinite)) {
        if (Number.isFinite(o) && Number.isFinite(c)) { h = Math.max(o, c); l = Math.min(o, c); } else continue;
      }
      candles.push({ t: tMs, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c });
    }
    if (candles.length && p) {
      candles.sort((a, b) => a.t - b.t);
      this.ev.onCandles(p.base, candles);
    }
  }

  // ---------------- subscription ----------------

  /** সাবস্ক্রিপশন মেসেজগুলো পেসড (120ms) — একসাথে পাঠালে সার্ভার কানেকশন কাটে */
  private pacedSubscribe() {
    if (this.closed || this.authState !== 'ok') return;
    const sends: string[] = [];
    for (const p of this.pairs) {
      sends.push(`42${JSON.stringify(['instruments/update', { asset: p.qAsset, period: 60 }])}`);
      sends.push(`42${JSON.stringify(['chart_notification/get', { asset: p.qAsset, version: '1.0.0' }])}`);
      sends.push(`42${JSON.stringify(['depth/follow', p.qAsset])}`);
    }
    // হিস্ট্রি ওয়ার্মআপ (প্রতি পেয়ারে ১২ ঘণ্টার ১ম ক্যান্ডেল)
    for (const p of this.pairs) {
      sends.push(`42${JSON.stringify(['history/load', {
        asset: p.qAsset, index: 0, time: Math.floor(Date.now() / 1000), offset: 720, period: 60,
      }])}`);
    }
    sends.forEach((s, i) => {
      this.subTimers.push(setTimeout(() => this.send(s), 400 + i * 120));
    });
  }

  private emitTick(p: QxPair, price: number, tMs: number) {
    this.gotTicks = true;
    this.ev.onTick(p.base, price, tMs);
  }
}
