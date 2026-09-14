import WebSocket from 'ws';
import type { Tick } from '../types';

// ============ Quotex (qxbroker) WebSocket Client ============
// Speaks the raw socket.io v4 (EIO=4) wire protocol over WS.
// The parser is intentionally tolerant: several known message
// formats are tried so the client adapts to the broker's current
// backend revision. Everything received is logged for remote debugging.

export interface QuotexEvents {
  onTick: (pair: string, price: number, t: number) => void;
  onCandles: (pair: string, candles: { t: number; o: number; h: number; l: number; c: number }[]) => void;
  onBalance: (balance: number, currency: string | null) => void;
  onStatus: (connected: boolean, reason: string) => void;
  onRaw: (line: string) => void;
  onLog: (msg: string) => void;
}

const WS_URL = 'wss://qxbroker.com/socket.io/?EIO=4&transport=websocket';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class QuotexClient {
  private ws: WebSocket | null = null;
  private token: string;
  private ev: QuotexEvents;
  private pairs: string[] = [];
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private gotTicks = false;

  constructor(token: string, ev: QuotexEvents) {
    this.token = token;
    this.ev = ev;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  get receivingTicks() {
    return this.gotTicks;
  }

  async fetchProfile(): Promise<{ login: string | null; balance: number | null; currency: string | null }> {
    const ssid = this.token.split(':')[0];
    const urls = [
      `https://qxbroker.com/api/profile?nocache=${Date.now()}`,
      `https://qxbroker.com/en/profile?nocache=${Date.now()}`,
    ];
    for (const u of urls) {
      try {
        const res = await fetch(u, {
          headers: { Cookie: `q9securid=${ssid};`, 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const j: any = await res.json();
        const login = j?.login || j?.user?.login || j?.email || null;
        const balanceRaw = j?.balance ?? j?.account?.balance ?? j?.user?.balance;
        const balance = Number(balanceRaw);
        const currency = j?.currency || j?.account?.currency || null;
        if (login || balanceRaw != null) {
          return { login, balance: Number.isFinite(balance) ? balance : null, currency };
        }
      } catch {
        /* try next */
      }
    }
    return { login: null, balance: null, currency: null };
  }

  connect(pairs: string[]) {
    this.closed = false;
    this.pairs = pairs;
    this.open();
  }

  private open() {
    if (this.closed) return;
    this.cleanup();
    const ssid = this.token.split(':')[0];
    this.ev.onLog(`Quotex WS সংযোগের চেষ্টা করা হচ্ছে... (attempt ${this.attempts + 1})`);
    try {
      this.ws = new WebSocket(WS_URL, {
        headers: {
          Cookie: `q9securid=${ssid};`,
          Origin: 'https://qxbroker.com',
          'User-Agent': UA,
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
      this.ev.onLog('WS খোলা হয়েছে, socket.io handshake পাঠানো হচ্ছে...');
    });
    this.ws.on('message', (data: WebSocket.RawData) => this.handle(data.toString()));
    this.ws.on('error', (e: Error) => {
      this.ev.onStatus(false, `ws error: ${e.message}`);
      this.ev.onLog(`WS ত্রুটি: ${e.message}`);
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.ev.onStatus(false, `closed (${code}) ${reason.toString().slice(0, 80)}`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.cleanup();
    this.attempts += 1;
    const delay = Math.min(30000, 3000 * this.attempts);
    this.ev.onLog(`${delay / 1000}s পরে পুনরায় সংযোগের চেষ্টা হবে...`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch { /* noop */ }
    }
    this.ws = null;
  }

  close() {
    this.closed = true;
    this.cleanup();
    this.ev.onLog('Quotex WS বন্ধ করা হয়েছে।');
  }

  private send(raw: string) {
    if (this.connected && this.ws) {
      this.ev.onRaw(`→ ${raw.slice(0, 160)}`);
      try { this.ws.send(raw); } catch { /* noop */ }
    }
  }

  // ---------- socket.io v4 protocol ----------
  private handle(msg: string) {
    if (msg.length < 2) return;
    this.ev.onRaw(`← ${msg.slice(0, 160)}`);

    // engine.io handshake
    if (msg.startsWith('0{')) {
      this.send('40');
      return;
    }
    if (msg.startsWith('40')) {
      this.ev.onLog('socket.io connected — সাবস্ক্রিপশন পাঠানো হচ্ছে...');
      this.ev.onStatus(true, 'connected');
      // server pings handled below
      this.pingTimer = setInterval(() => {}, 20000); // keepalive placeholder (reply handled on '2')
      for (const p of this.pairs) this.subscribePair(p);
      // request historical candles for warmup
      for (const p of this.pairs) this.requestCandles(p, 240);
      this.fetchProfile()
        .then((prof) => {
          if (prof.login || prof.balance != null) {
            this.ev.onBalance(prof.balance ?? 0, prof.currency);
            this.ev.onLog(`একাউন্ট: ${prof.login ?? '?'} | ব্যালেন্স: ${prof.balance ?? '?'}`);
          }
        })
        .catch(() => {});
      return;
    }
    if (msg === '2') { this.send('3'); return; }
    if (msg.startsWith('2') && msg.length > 1) return; // ping with data
    if (msg.startsWith('41')) return; // disconnect packet
    if (msg.startsWith('42')) {
      const body = msg.slice(2);
      try {
        const arr = JSON.parse(body);
        if (Array.isArray(arr)) this.dispatch(arr);
      } catch {
        // non-JSON payload — some revisions send raw CSV-like data
        this.parseNonJsonTick(body);
      }
      return;
    }
  }

  private subscribePair(pair: string) {
    // try the two known subscription formats
    this.send(`42${JSON.stringify(['subfor', pair])}`);
    this.send(`42${JSON.stringify(['change-symbol', { asset: pair, period: 60 }])}`);
  }

  private requestCandles(pair: string, offset: number) {
    this.send(
      `42${JSON.stringify(['instruments-candles', { asset: pair, period: 60, offset, index: 0 }])}`,
    );
    this.send(`42${JSON.stringify(['candles', { asset: pair, period: 60, offset }])}`);
  }

  private dispatch(arr: any[]) {
    const [head, payload] = arr;
    if (typeof head !== 'string') return;

    // Format A: ["EURUSD", "1.08432"] or ["EURUSD", 1.08432]
    if (/^[A-Z]{6}$/.test(head) && payload != null) {
      const price = Number(payload);
      if (Number.isFinite(price)) {
        this.emitTick(head, price);
        return;
      }
      // Format B: ["EURUSD", {price, symbol...}] or timestamps map
      if (typeof payload === 'object') this.parseTickObject(head, payload);
      return;
    }

    switch (head) {
      case 'p': {
        // ["p", {symbol, price, ...}] tick object
        const o = payload ?? {};
        const sym = o.symbol || o.asset || o.s;
        const price = Number(o.price ?? o.p ?? o.bid);
        if (sym && Number.isFinite(price)) this.emitTick(String(sym).toUpperCase(), price);
        return;
      }
      case 'success-updateBalance': {
        const b = Number(payload?.balance ?? payload?.amount ?? NaN);
        if (Number.isFinite(b)) this.ev.onBalance(b, payload?.currency ?? null);
        return;
      }
      case 'candles':
      case 'success-instruments-candles':
      case 'instruments-candles': {
        // payload: {asset, candles:[...]} or array of candles
        const candlesRaw = Array.isArray(payload) ? payload : payload?.candles;
        const pair = Array.isArray(payload) ? null : payload?.asset || payload?.symbol;
        if (Array.isArray(candlesRaw) && candlesRaw.length) {
          const candles = candlesRaw
            .map((c: any) => ({
              t: Number((c.t ?? c.time ?? c.timestamp ?? 0) * (c.t < 1e12 ? 1000 : 1)),
              o: Number(c.o ?? c.open),
              h: Number(c.h ?? c.high),
              l: Number(c.l ?? c.low),
              c: Number(c.c ?? c.close),
            }))
            .filter((c: any) => c.t > 0 && Number.isFinite(c.o) && Number.isFinite(c.c));
          if (candles.length && pair) this.ev.onCandles(String(pair).toUpperCase(), candles);
        }
        return;
      }
      case 'success-login':
      case 'success-auth': {
        this.ev.onLog('Quotex অথেন্টিকেশন সফল (socket event)।');
        return;
      }
      default:
        // unknown named events: keep for the log panel
        return;
    }
  }

  private parseTickObject(pair: string, o: any) {
    // Some revisions send {"EURUSD": {"price":...}} style maps inside payload
    if (o && typeof o === 'object') {
      const price = Number(o.price ?? o.p ?? o.bid ?? o.value);
      if (Number.isFinite(price)) {
        this.emitTick(pair, price);
        return;
      }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'number' && /^[0-9.]*$/.test(String(v))) {
          // ["USDJPY", {"USDJPY": 149.32}] style
          if (/^[A-Z]{6}$/.test(k)) this.emitTick(k, v);
        }
      }
    }
  }

  private parseNonJsonTick(body: string) {
    // formats like: 2["USDJPY", 149.321] arrive as 42-prefixed already handled.
    // csv fallback: "USDJPY,149.321"
    const m = body.match(/"?([A-Z]{6})"?[,\s]+([0-9.]+)/);
    if (m) this.emitTick(m[1], Number(m[2]));
  }

  private emitTick(pair: string, price: number) {
    this.gotTicks = true;
    this.ev.onTick(pair, price, Date.now());
  }
}
