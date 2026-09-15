# 🕯️ Candle Reaction — QX সিগন্যাল ইঞ্জিন (Quotex)

A tick-by-tick **Candle Reaction Signal Engine** for 1-minute binary options on Quotex. It watches every single tick the way a veteran trader wishes he could — every millisecond, every level, every flip — and emits **CALL / PUT** signals only when full confluence is confirmed at candle close.

> **মূল ফিলোসফি (The 4-Factor Confirmation):**
> `লেভেল/জোন + মার্কেট স্ট্রাকচার + ক্যান্ডেল ফুল ক্লোজ + পোস্ট-ক্লোজ রিয়েকশন = রিয়েল কনফার্মেশন`
> Level/Zone + Market Structure + Full Candle Close + Post-close Reaction = Real Confirmation

---

## 🧠 How it "thinks" — ইঞ্জিন যেভাবে চিন্তা করে

A human glances at a chart 2–4 times per second and keeps ~5 levels in memory.
This engine evaluates **every tick** (10–50+ ticks/sec) against **30+ numeric factors**, pip-precise, emotionless:

| Layer | What it computes per tick / per close |
|---|---|
| **Round-number levels** | Nearest 00/50-pip magnetic levels, distance in pips, touch count, reaction magnitude after each touch |
| **Key / swing zones** | Fractal swing highs-lows from last 60 candles, clustered into zones with touch-strength scoring |
| **Session levels** | Daily high/low, previous candle H/L, 15-min range extremes |
| **Momentum (ms-level)** | 1s / 3s / 5s / 10s micro-return windows, tick velocity + acceleration, tick-rate bursts |
| **Running candle internals** | Live color path per second, upper/lower wick dynamics, body-vs-wick conviction, tick imbalance (buy ticks vs sell ticks) |
| **Late color-flip detection** | The classic trap — candle red for 57–58s then flips green in the last 2s. Engine scores flip magnitude, body size, tick aggression to classify continuation vs trap |
| **Full-close read (CLV)** | Close Location Value — where the candle closed inside its range (top 25% = bullish conviction), range vs ATR expansion |
| **Market structure** | EMA9/21 stack + HH/HL vs LH/LL swing sequence → TREND_UP / TREND_DOWN / RANGE regime |
| **Post-close reaction** | First seconds of the NEW candle — do the ticks confirm the predicted direction? |

All factor scores combine into a weighted confluence score. A signal fires **only** when it crosses the confidence threshold (default 70%) — same pure function used in live mode AND backtest, zero look-ahead.

---

## ✅ Backtest (verified on REAL market data)

The engine is now **Python** and runs on **real data only** (no simulation, ever).
Two independent verifications:

**1. Differential port verification (bit-perfect):**
the old TypeScript engine and the new Python engine were run on the *same* 16,243-candle dataset — **15/15 signals identical** (same pair, timestamp, direction, score, result).

**2. Real-market backtest (Yahoo Finance 1-minute candles, 8 pairs, ~2 days):**

```
OVERALL: 15,089 real candles → 15 signals @ 70% confidence, WR 60% (W9 / L6)
  USDJPY: 4 sig, WR 75%      EURJPY: 5 sig, WR 60%
  GBPJPY: 4 sig, WR 50%      USDCAD: 1 sig, WR 100%
  USDCHF: 1 sig, WR 0%
```

- Quotex টোকেন সংযুক্ত থাকলে ব্যাকটেস্ট Quotex-এর নিজের হিস্ট্রি ক্যান্ডেলে চলে (history/load)
- Re-run anytime from **Settings → Backtest** tab inside the app

---

## 🏗️ Architecture

```
browser ── socket.io ──▶ qx-engine (Python: aiohttp + python-socketio, $PORT)
                          ├─ /engine/*   → socket.io (market stream + RPC)
                          ├─ /qx-health → liveness probe
                          └─ everything else → reverse proxy → Next.js UI (:3001)

qx-engine (mini-services/qx-engine, Python 3)
  ├─ quotex_client.py   raw socket.io (EIO=3) WS to ws2.qxbroker.com — session-token
  │                     authorization, paced subscriptions, isDemo auto-flip, tick +
  │                     candle-history parsing, binary frames, auto-reconnect w/ backoff
  ├─ yahoo_feed.py      REAL market fallback — 1-minute interbank candles (never simulation)
  ├─ candle_store.py    running candle: per-second color path, tick imbalance, 5s/10s momentum
  ├─ levels / structure / patterns   zones, EMA stack, CLV, pin bar, engulfing, late-flip
  ├─ signal_engine.py   pure confluence scorer (live + backtest share the same code)
  ├─ market_engine.py   minute-boundary orchestrator → resolve pending → evaluate → persist
  ├─ backtest.py        walk-forward runner + per-pair / per-direction / per-hour stats
  └─ db.py              self-bootstrapping SQLite (no external migrations)
```

- **Real-data-only**: paste a QX session token → LIVE Quotex tick feed (ws2.qxbroker.com) + your balance; no token / expired → real interbank market candles (Yahoo Finance) — the app is never empty and **never simulated**
- **Persistence**: SQLite — every signal with factor breakdown, reasons, PENDING → WIN/LOSS/TIE resolution
- **Frontend**: single page, 3 tabs (হোম / সিগন্যাল / সেটিংস), Bengali dark trading theme, lightweight-charts candlesticks with signal markers, live running-candle analyzer showing tick internals in real time

---

## 🚀 Run locally

```bash
# 1. main app
bun install
bun run db:push

# 2. engine (separate terminal)
cd mini-services/qx-engine
bun install
bun run dev          # starts on :3003

# 3. frontend
bun run dev          # Next.js on :3000
```

Open the app → **সেটিংস** tab → paste your QX token (`q9securid` cookie value) → **সংযোগ করুন**.

## 🚂 Deploy to Railway — ZERO-CONFIG

Full Bengali guide in [`DEPLOY.md`](DEPLOY.md). Just:

1. railway.app → **New Project** → **Deploy from GitHub repo** → this repo
2. Settings → Networking → **Generate Domain** — done, the app runs

**Everything is automatic** (no env vars, no manual setup):
- Railway's `PORT` is bound automatically by the engine (`0.0.0.0`)
- `railway.json` auto-configures the Dockerfile builder + `/qx-health` healthcheck; `package.json` start + `nixpacks.toml` make the same full-stack supervisor run under **any** builder (Nixpacks or Docker)
- SQLite auto-locates to `/data` (volume) or `/app/db` (fallback) — attach a volume at `/data` only if you want persistence across redeploys
- The engine **self-bootstraps its schema** on a fresh DB (`CREATE TABLE IF NOT EXISTS` at boot) — it cannot crash on an empty database
- A supervisor auto-restarts any process that dies; Next.js standalone runs under Node (most reliable), the TS engine under Bun
- **Auto-live (optional)**: set a `QX_TOKEN` variable in Railway → the engine connects to Quotex live automatically on every boot, no token paste needed (blue badge shows in Settings)
- Verify deployment: open `https://<your-domain>/qx-health` → `{"ok":true,...}`

> ⚠️ **Note**: Quotex/Cloudflare blocks some datacenter IPs. If the LIVE feed can't connect from Railway, the app transparently falls back to SIM mode (labeled in UI). A small VPS near your region usually connects fine — see `DEPLOY.md`.

---

## 📊 App tabs

- **হোম (Home)** — win-rate cards (1h / 6h / 24h / all), live market grid, per-pair WR table with CALL/PUT split, latest signals
- **সিগন্যাল (Signals)** — live candlestick chart with signal markers, **running-candle analyzer** (watch the engine think: tick internals, wick dynamics, momentum, live confluence score), full signal history with filters (pair / direction / period), backtest runner
- **সেটিংস (Settings)** — QX token connect/disconnect, engine mode, pair selection, confidence threshold, raw connection log

## 🔐 Security

- Tokens are **never** hardcoded in the repo — enter at runtime via the Settings tab (stored server-side only)
- `.env`, `db/`, logs and build output are git-ignored
- Rotate your QX token if you ever pasted it in a chat

## ⚠️ Disclaimer

শিক্ষামূলক ও গবেষণার উদ্দেশ্যে তৈরি। বাইনারি অপশন ট্রেডিং অত্যন্ত ঝুঁকিপূর্ণ — কোনো সিগন্যাল ইঞ্জিনই লাভের গ্যারান্টি দিতে পারে না। নিজের ঝুঁকিতে ব্যবহার করুন।
For education and research only. Binary options trading is extremely risky — no signal engine can guarantee profit. Use at your own risk.
