"""SQLite layer — self-bootstrapping schema (mirrors prisma/schema.prisma).

ts stored as epoch-ms INTEGER (clean break from the old prisma string format —
the engine wipes stale simulated data at boot and refills from real feeds).
"""

import os
import sqlite3
import threading
import time
from datetime import datetime, timezone

DDL = [
    """CREATE TABLE IF NOT EXISTS "Setting" (
      "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
      "qxToken" TEXT,
      "mode" TEXT NOT NULL DEFAULT 'live',
      "minConfidence" INTEGER NOT NULL DEFAULT 70,
      "pairs" TEXT NOT NULL DEFAULT 'EURUSD,USDJPY,AUDUSD,GBPUSD,EURJPY,GBPJPY,USDCAD,USDCHF',
      "lastBacktest" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS "Candle" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "pair" TEXT NOT NULL,
      "ts" INTEGER NOT NULL,
      "open" REAL NOT NULL, "high" REAL NOT NULL, "low" REAL NOT NULL, "close" REAL NOT NULL,
      "ticks" INTEGER NOT NULL DEFAULT 0, "upTicks" INTEGER NOT NULL DEFAULT 0, "downTicks" INTEGER NOT NULL DEFAULT 0,
      "lateFlip" INTEGER NOT NULL DEFAULT 0, "lateMomentum" REAL NOT NULL DEFAULT 0,
      "flipCount" INTEGER NOT NULL DEFAULT 0,
      "source" TEXT NOT NULL DEFAULT 'LIVE',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS "Signal" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "pair" TEXT NOT NULL,
      "ts" INTEGER NOT NULL,
      "direction" TEXT NOT NULL,
      "confidence" INTEGER NOT NULL,
      "score" INTEGER NOT NULL,
      "reasons" TEXT NOT NULL,
      "entryPrice" REAL NOT NULL,
      "closePrice" REAL,
      "result" TEXT NOT NULL DEFAULT 'PENDING',
      "source" TEXT NOT NULL DEFAULT 'LIVE',
      "backtestId" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    'CREATE INDEX IF NOT EXISTS "Candle_pair_ts_index" ON "Candle" ("pair", "ts")',
    'CREATE INDEX IF NOT EXISTS "Signal_pair_ts_index" ON "Signal" ("pair", "ts")',
    'CREATE INDEX IF NOT EXISTS "Signal_source_ts_index" ON "Signal" ("source", "ts")',
    'CREATE INDEX IF NOT EXISTS "Signal_result_ts_index" ON "Signal" ("result", "ts")',
]


def _parse_ts(v):
    """Existing rows may be epoch-ms ints (new) or prisma ISO strings (old)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()
    if s.isdigit():
        return int(s)
    try:
        return int(float(s))
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z",
                "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return int(datetime.strptime(s.replace("+00:00", "+0000"), fmt)
                       .replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    return None


class DB:
    def __init__(self, url: str):
        path = url[5:] if url.startswith("file:") else url
        path = path.split("?")[0]
        if not path or path == ":memory:":
            path = ":memory:"
        else:
            os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, timeout=15)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        cur = self.conn.cursor()
        for pragma in ("PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000",
                       "PRAGMA synchronous=NORMAL"):
            try:
                cur.execute(pragma)
            except sqlite3.Error:
                pass
        for stmt in DDL:
            cur.execute(stmt)
        self.conn.commit()
        cur.close()

    # ---------- settings ----------
    def ensure_settings(self) -> dict:
        with self.lock:
            row = self.conn.execute('SELECT * FROM "Setting" WHERE id=?', ("main",)).fetchone()
            if not row:
                self.conn.execute(
                    'INSERT INTO "Setting" ("id","mode","minConfidence","pairs","createdAt","updatedAt") '
                    'VALUES (?,?,?,? ,CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
                    ("main", "live", 70,
                     "EURUSD,USDJPY,AUDUSD,GBPUSD,EURJPY,GBPJPY,USDCAD,USDCHF"))
                self.conn.commit()
                row = self.conn.execute('SELECT * FROM "Setting" WHERE id=?', ("main",)).fetchone()
            return dict(row)

    def update_setting(self, **fields):
        if not fields:
            return
        cols = ", ".join(f'"{k}"=?' for k in fields)
        with self.lock:
            self.conn.execute(f'UPDATE "Setting" SET {cols}, "updatedAt"=CURRENT_TIMESTAMP WHERE id=?',
                              (*fields.values(), "main"))
            self.conn.commit()

    # ---------- candles ----------
    def load_candles(self, pair: str, take: int = 700):
        with self.lock:
            rows = self.conn.execute(
                'SELECT * FROM "Candle" WHERE "pair"=? ORDER BY "ts" DESC LIMIT ?',
                (pair, take)).fetchall()
        out = []
        for r in reversed(rows):  # ascending
            out.append(self._row_to_candle(r))
        return out

    def load_candles_since(self, pair: str, ts_ms: int):
        with self.lock:
            rows = self.conn.execute(
                'SELECT * FROM "Candle" WHERE "pair"=? AND "ts">=? ORDER BY "ts" ASC',
                (pair, ts_ms)).fetchall()
        return [self._row_to_candle(r) for r in rows]

    def last_candle_ts(self, pair: str):
        with self.lock:
            r = self.conn.execute(
                'SELECT MAX("ts") AS m FROM "Candle" WHERE "pair"=?', (pair,)).fetchone()
        if r and r["m"] is not None:
            v = _parse_ts(r["m"])
            return v
        return None

    def insert_candles(self, candles):
        if not candles:
            return
        with self.lock:
            cur = self.conn.cursor()
            for c in candles:
                cur.execute(
                    'INSERT OR IGNORE INTO "Candle" '
                    '("id","pair","ts","open","high","low","close","ticks","upTicks","downTicks",'
                    '"lateFlip","lateMomentum","flipCount","source") '
                    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (f'{c["pair"]}:{c["ts"]}', c["pair"], int(c["ts"]),
                     c["open"], c["high"], c["low"], c["close"],
                     c.get("ticks", 0), c.get("upTicks", 0), c.get("downTicks", 0),
                     c.get("lateFlip", 0), c.get("lateMomentum", 0.0),
                     c.get("flipCount", 0), c.get("source", "LIVE")))
            self.conn.commit()
            cur.close()

    def purge_simulation_data(self):
        """সিমুলেশন চিরতরে বিদায় — wipe all legacy fake + stale rows."""
        with self.lock:
            cur = self.conn.cursor()
            try:
                cur.execute('DELETE FROM "Candle"')
                cur.execute('DELETE FROM "Signal" WHERE "source" IN (\'SIM\',\'BACKTEST\')')
                self.conn.commit()
            except sqlite3.Error as e:
                print(f"[db] purge warning: {e}")
            finally:
                cur.close()

    def count_candles(self, pair: str) -> int:
        with self.lock:
            r = self.conn.execute('SELECT COUNT(*) AS n FROM "Candle" WHERE "pair"=?', (pair,)).fetchone()
        return int(r["n"]) if r else 0

    @staticmethod
    def _row_to_candle(r) -> dict:
        ts = _parse_ts(r["ts"]) or 0
        return {
            "pair": r["pair"], "ts": ts,
            "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
            "ticks": r["ticks"] or 0, "upTicks": r["upTicks"] or 0, "downTicks": r["downTicks"] or 0,
            "lateFlip": r["lateFlip"] or 0, "lateMomentum": r["lateMomentum"] or 0.0,
            "flipCount": r["flipCount"] or 0, "source": r["source"] or "LIVE",
        }

    # ---------- signals ----------
    def insert_signal(self, s: dict):
        import json as _json
        with self.lock:
            self.conn.execute(
                'INSERT OR IGNORE INTO "Signal" '
                '("id","pair","ts","direction","confidence","score","reasons","entryPrice",'
                '"closePrice","result","source","backtestId") '
                'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (s["id"], s["pair"], int(s["ts"]), s["direction"], int(s["confidence"]),
                 int(s["score"]), _json.dumps(s.get("reasons", []), ensure_ascii=False),
                 s["entryPrice"], s.get("closePrice"), s.get("result", "PENDING"),
                 s.get("source", "LIVE"), s.get("backtestId")))
            self.conn.commit()

    def insert_signals(self, signals):
        for s in signals:
            try:
                self.insert_signal(s)
            except sqlite3.Error:
                pass

    def update_signal_result(self, sid: str, close_price: float, result: str):
        with self.lock:
            self.conn.execute(
                'UPDATE "Signal" SET "closePrice"=?, "result"=? WHERE "id"=?',
                (close_price, result, sid))
            self.conn.commit()

    def query_signals(self, pair="ALL", direction="ALL", period_h=0, sources=None, limit=100):
        import json as _json
        sources = sources or ["LIVE"]
        where = ['"source" IN (%s)' % ",".join("?" * len(sources))]
        args = list(sources)
        if pair and pair != "ALL":
            where.append('"pair"=?')
            args.append(pair)
        if direction and direction != "ALL":
            where.append('"direction"=?')
            args.append(direction)
        if period_h and period_h > 0:
            where.append('"ts">=?')
            args.append(int((time.time() - period_h * 3600) * 1000))
        sql = 'SELECT * FROM "Signal" WHERE %s ORDER BY "ts" DESC LIMIT ?' % " AND ".join(where)
        args.append(min(limit, 500))
        with self.lock:
            rows = self.conn.execute(sql, args).fetchall()
        out = []
        for r in rows:
            ts = _parse_ts(r["ts"]) or 0
            try:
                reasons = _json.loads(r["reasons"] or "[]")
            except Exception:
                reasons = []
            out.append({
                "id": r["id"], "pair": r["pair"], "ts": ts,
                "direction": r["direction"], "confidence": r["confidence"],
                "score": r["score"], "reasons": reasons,
                "entryPrice": r["entryPrice"], "closePrice": r["closePrice"],
                "result": r["result"], "source": r["source"],
            })
        return out

    def delete_signals(self, sources):
        with self.lock:
            self.conn.execute('DELETE FROM "Signal" WHERE "source" IN (%s)'
                              % ",".join("?" * len(sources)), tuple(sources))
            self.conn.commit()
