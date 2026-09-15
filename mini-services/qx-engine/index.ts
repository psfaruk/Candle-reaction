import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server } from 'socket.io';
import httpProxy from 'http-proxy';
import { MarketEngine } from './src/engine/market-engine';
import { ensureSchema, ensureSettings } from './src/db';
import { ALL_PAIRS } from './src/pairs';

// ============================================================
// 🛡 CRASH PROTECTION — ইঞ্জিন সারাক্ষণ চালু থাকবে।
// bun/node ডিফল্টে unhandled rejection-এ প্রসেস মেরে ফেলে —
// একটা stray async এররে (DB lock, WS glitch) পুরো অ্যাপ ডাউন হতো।
// এখন এরর লগ হবে, প্রসেস বেঁচে থাকবে, সকেট-সংযোগ টিকে থাকবে।
// ============================================================
process.on('uncaughtException', (e) => {
  console.error('[qx-engine] ⚠ uncaughtException (অ-মারাত্মক, ইঞ্জিন চালু থাকবে):', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[qx-engine] ⚠ unhandledRejection (অ-মারাত্মক, ইঞ্জিন চালু থাকবে):', e);
});
process.on('warning', (w) => {
  console.warn('[qx-engine] warning:', w?.message ?? w);
});

// ============ QX Engine — socket.io service ============
// Production architecture (single public port):
//   browser → engine:$PORT
//     /engine/*  → socket.io (realtime market data + RPC)
//     everything else → proxied to the Next.js server (QX_NEXT_PORT)
// Sandbox architecture: Caddy gateway routes by XTransformPort query.

const PORT = Number(process.env.QX_ENGINE_PORT || process.env.PORT || 3003);
const NEXT_PORT = Number(process.env.QX_NEXT_PORT || 3000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DB বুট — কখনো হাল ছাড়ে না (SQLite লক/IO হলে 2s পরে আবার) */
async function bootDb(retries = 30): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    try {
      await ensureSchema();
      await ensureSettings();
      return;
    } catch (e) {
      console.error(`[qx-engine] ⚠ DB বুট ব্যর্থ (চেষ্টা ${i}/${retries}):`, e instanceof Error ? e.message : e);
      await sleep(2000);
    }
  }
  throw new Error('DB বুট বারবার ব্যর্থ');
}

/** পোর্ট বাইন্ড — EADDRINUSE হলে অপেক্ষা করে আবার */
function listenForever(httpServer: import('http').Server, port: number): Promise<void> {
  return new Promise((resolve) => {
    const bind = () => {
      httpServer.once('error', (e: Error) => {
        console.error(`[qx-engine] ⚠ পোর্ট ${port} বাইন্ড ব্যর্থ (${e.message}) — 2s পরে আবার চেষ্টা`);
        setTimeout(bind, 2000);
      });
      httpServer.listen(port, '0.0.0.0', () => resolve());
    };
    bind();
  });
}

async function main() {
  // self-bootstrap: create tables if missing (fresh DB / new volume), then settings row
  await bootDb();

  const httpServer = createServer();
  const io = new Server(httpServer, {
    path: '/engine',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 5e6,
  });

  const engine = new MarketEngine();

  // proxy everything that is not /engine to the Next.js server
  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${NEXT_PORT}`, ws: false });
  proxy.on('error', (_err: Error, _req: IncomingMessage, res: ServerResponse) => {
    if (res.writeHead) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('next-server unreachable');
  });
  httpServer.on('request', (req, res) => {
    const url = req.url ?? '/';
    // liveness/readiness probe for Railway & orchestrators
    if (url === '/qx-health' || url.startsWith('/qx-health')) {
      const body = JSON.stringify({
        ok: true,
        service: 'qx-engine',
        mode: engine.statusSnapshot().mode,
        pairs: ALL_PAIRS.length,
        uptimeSec: Math.round(process.uptime()),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (url.startsWith('/engine')) return; // socket.io handles it
    proxy.web(req, res);
  });

  io.on('connection', (socket) => {
    // initial handshake payload
    socket.emit('hello', {
      status: engine.statusSnapshot(),
      settings: engine.getSettings(),
      logs: engine.getLogs(),
    });

    // ---- request/response events ----
    const ack = <T>(cb: (r: T) => void, r: T) => { if (typeof cb === 'function') cb(r); };

    socket.on('get-market', (_d: unknown, cb: (r: unknown) => void) => ack(cb, engine.snapshot()));
    socket.on('get-status', (_d: unknown, cb: (r: unknown) => void) => ack(cb, engine.statusSnapshot()));
    socket.on('get-settings', (_d: unknown, cb: (r: unknown) => void) => ack(cb, engine.getSettings()));
    socket.on('get-history', (d: { pair: string; limit?: number }, cb: (r: unknown) => void) =>
      ack(cb, { candles: engine.getHistory(d?.pair, Math.min(d?.limit ?? 180, 400)) }),
    );
    socket.on('get-signals', (d: { pair?: string; direction?: string; periodH?: number; source?: string[]; limit?: number }, cb: (r: unknown) => void) => {
      engine
        .getSignals({
          pair: d?.pair ?? 'ALL',
          direction: (d?.direction ?? 'ALL') as any,
          periodH: d?.periodH ?? 0,
          source: d?.source,
          limit: d?.limit ?? 120,
        })
        .then((signals) => ack(cb, { signals }))
        .catch((e) => ack(cb, { signals: [], error: String(e) }));
    });
    socket.on('get-stats', (d: { periodH?: number; source?: string[] }, cb: (r: unknown) => void) => {
      engine
        .getStats({ periodH: d?.periodH ?? 0, source: d?.source })
        .then((s) => ack(cb, s))
        .catch((e) => ack(cb, { overall: null, perPair: [], error: String(e) }));
    });
    socket.on('get-log', (_d: unknown, cb: (r: unknown) => void) =>
      ack(cb, { logs: engine.getLogs(), raw: engine.getRawLog() }),
    );

    socket.on('save-settings', (d: { pairs?: string[]; minConfidence?: number; mode?: string }, cb: (r: unknown) => void) => {
      engine
        .saveSettings({ pairs: d?.pairs, minConfidence: d?.minConfidence, mode: d?.mode })
        .then((r) => ack(cb, r))
        .catch((e) => ack(cb, { ok: false, msg: String(e) }));
    });

    socket.on('connect-token', async (d: { token: string }, cb: (r: unknown) => void) => {
      const token = (d?.token || '').trim();
      if (!token || token.length < 10) {
        ack(cb, { ok: false, msg: 'টোকেন খুব ছোট — সঠিক QX টোকেন দিন' });
        return;
      }
      try {
        const r = await engine.startLive(token);
        ack(cb, r);
      } catch (e: any) {
        ack(cb, { ok: false, msg: String(e?.message ?? e) });
      }
    });

    socket.on('disconnect-live', (_d: unknown, cb: (r: unknown) => void) => {
      engine.stopLive();
      ack(cb, { ok: true, msg: 'লাইভ সংযোগ বন্ধ — সিমুলেশন ফিড চালু' });
    });

    socket.on('run-backtest', (_d: unknown, cb: (r: unknown) => void) => {
      engine
        .runBacktest()
        .then((s) => ack(cb, { ok: true, summary: s }))
        .catch((e) => ack(cb, { ok: false, msg: String(e) }));
    });

    socket.on('get-backtest', (_d: unknown, cb: (r: unknown) => void) => {
      engine
        .getLastBacktest()
        .then((s) => ack(cb, { ok: true, summary: s }))
        .catch((e) => ack(cb, { ok: false, msg: String(e) }));
    });
  });

  // listen FIRST so /qx-health + the UI are reachable immediately —
  // history generation and the QX_TOKEN live-connect attempt happen in
  // engine.start() afterwards (socket RPCs stay safe: engine is constructed)
  await listenForever(httpServer, PORT);
  console.log(`[qx-engine] ✅ listening on 0.0.0.0:${PORT} (socket.io path /engine, health /qx-health, next proxy → :${NEXT_PORT}, pairs: ${ALL_PAIRS.length})`);

  // 🛡 লিসেনার সেল্ফ-হিল: কোনো কারণে পোর্ট মারা গেলে 5s পরে নিজে থেকেই পুনরায় বাইন্ড
  // (sandbox auto-start এর পরেও ইঞ্জিন সারাক্ষণ চালু থাকবে)
  setInterval(() => {
    if (!httpServer.listening) {
      console.warn('[qx-engine] ⚠ লিসেনার নেই — পুনরায় বাইন্ড করা হচ্ছে…');
      try { httpServer.listen(PORT, '0.0.0.0'); } catch (e) { /* পরের টিকে আবার */ }
    }
  }, 5000);

  // ইঞ্জিন স্টার্ট — DB হিকাপ হলে 3 বার চেষ্টা, তারপরও প্রসেস বাঁচিয়ে রাখি (health + proxy চালু)
  for (let i = 1; i <= 3; i++) {
    try {
      await engine.start(io);
      break;
    } catch (e) {
      console.error(`[qx-engine] ⚠ engine.start ব্যর্থ (চেষ্টা ${i}/3):`, e instanceof Error ? e.message : e);
      if (i < 3) await sleep(3000);
    }
  }

  const shutdown = () => {
    console.log('[qx-engine] shutting down...');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// FATAL হলেও মরবে না — 5s পরে পুরো বুট আবার (সুপারভাইজারের আগে নিজেই সারার চেষ্টা)
main().catch((e) => {
  console.error('[qx-engine] FATAL — 5s পরে পুনরায় বুট হবে:', e);
  setInterval(() => {
    main().catch((e2) => console.error('[qx-engine] রিবুটও ব্যর্থ:', e2));
  }, 5000);
});
