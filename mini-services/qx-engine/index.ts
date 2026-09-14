import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server } from 'socket.io';
import httpProxy from 'http-proxy';
import { MarketEngine } from './src/engine/market-engine';
import { ensureSchema, ensureSettings } from './src/db';
import { ALL_PAIRS } from './src/pairs';

// ============ QX Engine — socket.io service ============
// Production architecture (single public port):
//   browser → engine:$PORT
//     /engine/*  → socket.io (realtime market data + RPC)
//     everything else → proxied to the Next.js server (QX_NEXT_PORT)
// Sandbox architecture: Caddy gateway routes by XTransformPort query.

const PORT = Number(process.env.QX_ENGINE_PORT || process.env.PORT || 3003);
const NEXT_PORT = Number(process.env.QX_NEXT_PORT || 3000);

async function main() {
  // self-bootstrap: create tables if missing (fresh DB / new volume), then settings row
  await ensureSchema();
  await ensureSettings();

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
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[qx-engine] ✅ listening on 0.0.0.0:${PORT} (socket.io path /engine, health /qx-health, next proxy → :${NEXT_PORT}, pairs: ${ALL_PAIRS.length})`);
  });

  await engine.start(io);

  const shutdown = () => {
    console.log('[qx-engine] shutting down...');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[qx-engine] FATAL:', e);
  process.exit(1);
});
