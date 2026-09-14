import { PrismaClient } from '@prisma/client';

const DB_URL = process.env.DATABASE_URL || 'file:/home/z/my-project/db/custom.db';

export const db = new PrismaClient({
  datasources: { db: { url: DB_URL } },
  log: ['error', 'warn'],
});

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
