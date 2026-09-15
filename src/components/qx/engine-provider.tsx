'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  EngineStatus, LogLine, MarketSnapshot, SignalRec, Candle,
} from '@/lib/qx-types';

export interface EngineSettingsView {
  tokenMasked: string;
  tokenSource?: 'env' | 'db';
  mode: string;
  minConfidence: number;
  pairs: string[];
  allPairs: { symbol: string; name: string }[];
}

interface EngineCtx {
  connected: boolean;
  status: EngineStatus | null;
  market: MarketSnapshot | null;
  logs: LogLine[];
  settings: EngineSettingsView | null;
  rpc: <T>(event: string, payload?: unknown) => Promise<T>;
  // last event ticks so tabs can refetch
  signalTick: number;
  candleTick: { pair: string; tick: number } | null;
  reconnect: () => void;
}

const Ctx = createContext<EngineCtx | null>(null);

export function useEngine(): EngineCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useEngine must be used inside EngineProvider');
  return c;
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [settings, setSettings] = useState<EngineSettingsView | null>(null);
  const [signalTick, setSignalTick] = useState(0);
  const [candleTick, setCandleTick] = useState<{ pair: string; tick: number } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // IMPORTANT: gateway path — always '/engine'; XTransformPort query routes
    // to the engine service through the sandbox Caddy gateway. In production
    // the engine IS the public server, so the same path works unchanged.
    const socket = io({
      path: '/engine',
      query: { XTransformPort: 3003 },
      // polling first = maximally proxy-compatible (works even where WS
      // upgrades are blocked); socket.io upgrades to websocket after
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
      timeout: 12000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('hello', (d: { status: EngineStatus; settings: EngineSettingsView; logs: LogLine[] }) => {
      setStatus(d.status);
      setSettings(d.settings);
      setLogs(d.logs ?? []);
    });
    socket.on('market', (m: MarketSnapshot) => {
      setMarket(m);
      setStatus(m.status);
    });
    socket.on('status', (s: EngineStatus) => setStatus(s));
    socket.on('log', (l: LogLine) => setLogs((prev) => [...prev.slice(-149), l]));
    socket.on('signal:new', (_s: SignalRec) => setSignalTick((t) => t + 1));
    socket.on('signal:resolved', (_s: SignalRec) => setSignalTick((t) => t + 1));
    socket.on('candle:closed', (d: { pair: string; candle: Candle }) =>
      setCandleTick({ pair: d.pair, tick: Date.now() }),
    );

    return () => {
      socket.disconnect();
    };
  }, [nonce]);

  const rpc = useCallback(<T,>(event: string, payload?: unknown): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const emit = (sock: Socket) => {
        // ২০ সে.: connect-token সর্বোচ্চ ১৫ সে. বিশ্লেষণ করে তারপর উত্তর দেয়
        const timer = setTimeout(() => reject(new Error('রিকোয়েস্ট টাইমআউট')), 20000);
        sock.emit(event, payload ?? {}, (r: T) => {
          clearTimeout(timer);
          resolve(r);
        });
      };
      const s = socketRef.current;
      if (s && s.connected) {
        emit(s);
        return;
      }
      // সকেট ডাউন → সকেট.অআই-এর অটো-রিকানেক্টের জন্য ১২ সে. পর্যন্ত অপেক্ষা করে
      // তারপর রিকোয়েস্ট পাঠানো হয় — বাটন ক্লিক কখনো বৃথা যায় না
      const startedAt = Date.now();
      const iv = setInterval(() => {
        const s2 = socketRef.current;
        if (s2 && s2.connected) {
          clearInterval(iv);
          emit(s2);
        } else if (Date.now() - startedAt > 12000) {
          clearInterval(iv);
          reject(new Error('ইঞ্জিন এখনো সাড়া দিচ্ছে না — ইঞ্জিন চালু হলে বাটন নিজেই কাজ করবে, একটু পরে আবার চাপুন'));
        }
      }, 250);
    });
  }, []);

  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  // স্টাক-সকেট অটো-রিভাইভ: ৩০ সে. ধরে সংযোগ না হলে সকেট নতুন করে তৈরি হয়
  useEffect(() => {
    if (connected) return;
    const t = setTimeout(() => setNonce((n) => n + 1), 30000);
    return () => clearTimeout(t);
  }, [connected, nonce]);

  // refresh settings periodically (token connect / save happen in other tabs)
  useEffect(() => {
    if (!connected) return;
    const iv = setInterval(() => {
      rpc<EngineSettingsView>('get-settings').then(setSettings).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, [connected, rpc]);

  const value: EngineCtx = {
    connected, status, market, logs, settings, rpc, signalTick, candleTick, reconnect,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
