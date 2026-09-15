import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { PrismaClient } from '@prisma/client';

const DB_URL = process.env.DATABASE_URL || 'file:/home/z/my-project/db/custom.db';

// self-healing: ensure the SQLite parent directory exists (fresh volume /
// misconfigured DATABASE_URL must never crash the engine at boot)
try {
  if (DB_URL.startsWith('file:')) {
    const p = DB_URL.slice(5).split('?')[0];
    if (p && !p.startsWith(':memory:')) mkdirSync(dirname(p), { recursive: true });
  }
} catch { /* best-effort */ }

export const db = new PrismaClient({
  datasources: { db: { url: DB_URL } },
  log: ['error', 'warn'],
});

// ============================================================
// Self-bootstrapping schema (CREATE TABLE IF NOT EXISTS).
// Mirrors prisma/schema.prisma exactly. This guarantees the engine
// can ALWAYS boot on a fresh/empty SQLite file (Railway volume or
// ephemeral disk) even if `prisma db push` never ran — the engine
// heals its own database. Raw DDL via $executeRawUnsafe works before
// any tables exist, so it doubles as first-boot migration.
// ============================================================
const DDL = [
  `CREATE TABLE IF NOT EXISTS "Setting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
    "qxToken" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "minConfidence" INTEGER NOT NULL DEFAULT 70,
    "pairs" TEXT NOT NULL DEFAULT 'EURUSD,USDJPY,AUDUSD,GBPUSD,EURJPY,GBPJPY,USDCAD,USDCHF',
    "lastBacktest" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "Candle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pair" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "ticks" INTEGER NOT NULL DEFAULT 0,
    "upTicks" INTEGER NOT NULL DEFAULT 0,
    "downTicks" INTEGER NOT NULL DEFAULT 0,
    "lateFlip" INTEGER NOT NULL DEFAULT 0,
    "lateMomentum" REAL NOT NULL DEFAULT 0,
    "flipCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'SIM',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pair" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "direction" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "closePrice" REAL,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'SIM',
    "backtestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "Candle_pair_ts_index" ON "Candle" ("pair", "ts")`,
  `CREATE INDEX IF NOT EXISTS "Signal_pair_ts_index" ON "Signal" ("pair", "ts")`,
  `CREATE INDEX IF NOT EXISTS "Signal_source_ts_index" ON "Signal" ("source", "ts")`,
  `CREATE INDEX IF NOT EXISTS "Signal_result_ts_index" ON "Signal" ("result", "ts")`,
];

export async function ensureSchema(): Promise<void> {
  for (const stmt of DDL) {
    await db.$executeRawUnsafe(stmt);
  }
  // SQLite টিউনিং: WAL মোড + busy timeout → সমান্তরাল লেখায় "database is
  // locked" এরর প্রায় শূন্যে নামে, ইঞ্জিন সারাক্ষণ মসৃণ থাকে।
  // নোট: কোনো PRAGMA রেজাল্ট-সারি ফেরায় (queryRaw লাগে), কোনোটা কিছু ফেরায় না
  // (executeRaw লাগে) — আর রানটাইমভেদে (bun/node) আচরণ বদলায়। তাই প্রতিটির
  // জন্য queryRaw → executeRaw ফলব্যাক, সব best-effort।
  const pragmas = [
    'PRAGMA busy_timeout=5000;',
    'PRAGMA journal_mode=WAL;',
    'PRAGMA synchronous=NORMAL;',
  ];
  for (const p of pragmas) {
    try {
      await db.$queryRawUnsafe(p);
    } catch {
      try { await db.$executeRawUnsafe(p); } catch { /* best-effort */ }
    }
  }
}

export async function ensureSettings(): Promise<{
  qxToken: string | null;
  mode: string;
  minConfidence: number;
  pairs: string;
}> {
  let s = await db.setting.findUnique({ where: { id: 'main' } });
  if (!s) {
    s = await db.setting.create({
      data: {
        id: 'main',
        qxToken: null,
        mode: 'auto',
        minConfidence: 70,
        pairs: 'EURUSD,USDJPY,AUDUSD,GBPUSD,EURJPY,GBPJPY,USDCAD,USDCHF',
      },
    });
  }
  return {
    qxToken: s.qxToken,
    mode: s.mode,
    minConfidence: s.minConfidence,
    pairs: s.pairs,
  };
}
