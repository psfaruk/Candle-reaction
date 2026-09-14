# QX ক্যান্ডেল রিয়েকশন সিগন্যাল ইঞ্জিন — Railway ডিপ্লয় গাইড

এই অ্যাপ দুইটি প্রসেস নিয়ে একটি কনটেইনারে চলে:

| প্রসেস | পোর্ট | কাজ |
|---|---|---|
| qx-engine (bun + socket.io) | `$PORT` (পাবলিক) | Quotex লাইভ ফিড / সিমুলেটর, টিক→ক্যান্ডেল বিল্ডার, সিগন্যাল ইঞ্জিন, ব্যাকটেস্ট, SQLite |
| Next.js (standalone) | `3001` (ইন্টার্নাল) | ফ্রন্টএন্ড UI |

ইঞ্জিন `$PORT`-এ সব রিকোয়েস্ট রিসিভ করে: `/engine/*` → socket.io, বাকি সব → Next.js-এ প্রক্সি।

## ডিপ্লয় ধাপ (Railway)

1. **GitHub-এ পুশ করুন**
   ```bash
   git init && git add . && git commit -m "QX signal engine"
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
   (`.gitignore`-এ `db/`, `node_modules`, `.next` ইত্যাদি বাদ আছে — লোকাল ডেটাবেস আপলোড হবে না।)

2. **Railway-তে নতুন প্রজেক্ট**: [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → রিপো সিলেক্ট করুন। Railway `Dockerfile` অটো-ডিটেক্ট করে বিল্ড করবে (বিল্ডে ~৩-৫ মিনিট)।

3. **ভলিউম যোগ করুন** (SQLite পার্সিস্টেন্সের জন্য — এটা ছাড়া রিডিপ্লয়ে সিগন্যাল হিস্ট্রি হারাবে):
   - Service → **Settings** → **Volumes** → **Add Volume**
   - Mount path: `/data`

4. **এনভায়রনমেন্ট ভ্যারিয়েবল** (Variables ট্যাব):
   | ভ্যারিয়েবল | ভ্যালু | প্রয়োজন |
   |---|---|---|
   | `DATABASE_URL` | `file:/data/qx.db` | আবশ্যক (ভলিউম মাউন্টের সাথে মিলতে হবে) |

5. **ডোমেইন চালু করুন**: Settings → **Networking** → **Generate Domain**।

6. **QX টোকেন কানেক্ট**: সাইট খুলে **সেটিংস ট্যাব** → টোকেন পেস্ট → **সংযোগ করুন**।
   টোকেন নেওয়ার নিয়ম: qxbroker.com-এ লগইন → DevTools (F12) → Application → Cookies → `q9securid`-এর ভ্যালু কপি।
   সংযোগ সফল হলে হোমে **লাইভ Quotex** ব্যাজ দেখাবে, সিগন্যাল `LIVE` সোর্সে যাবে, ব্যালেন্সও দেখাবে।

## গুরুত্বপূর্ণ নোট

- **রেলওয়ের IP কি Quotex/Cloudflare ব্লক করবে?** Quotex (qxbroker.com) ডেটাসেন্টার IP-তে কঠোর Cloudflare সুরক্ষা রাখে। Railway-র IP ব্লকড হলে লাইভ কানেকশন ফেইল করবে এবং অ্যাপ অটো সিমুলেশনে ফিরে যাবে (লগ দেখতে পাবেন সেটিংস ট্যাবে)। যদি তাই হয়:
  - **VPS অপশন**: Hetzner/Contabo-র সস্তা VPS-এ একই Dockerfile চালান (`docker build -t qx . && docker run -e PORT=8080 -v qxdata:/data -p 8080:8080 qx`) — রেসিডেনশিয়াল-ঘেঁষা IP পেতে চাইলে আলাদা প্রক্সি লাগতে পারে।
  - কানেকশন লগ ও raw WS ইভেন্ট (সেটিংস ট্যাবের নিচে) দেখে বুঝবেন ঠিক কোথায় আটকেছে।
- **সিগন্যাল লজিক অপরিবর্তিত**: লাইভ হোক বা সিমুলেশন — ইঞ্জিনের কনফার্মেশন মডেল একই (লেভেল/জোন + স্ট্রাকচার + ফুল ক্লোজ + রিয়েকশন)।
- **টোকেন নিরাপত্তা**: টোকেন সার্ভারের SQLite-এ সেভ হয়, ব্রাউজারে ফুল টোকেন কখনো ফেরত যায় না (মাস্কড দেখায়)। যে কেউ URL জানলেই আপনার ড্যাশবোর্ড দেখতে পারবে, তাই ডোমেইন গোপন রাখুন।
- **ঝুঁকি সতর্কতা**: বাইনারি অপশন অত্যন্ত ঝুঁকিপূর্ণ। এই টুল টেকনিক্যাল অ্যানালাইসিস সাহায্যের জন্য; কোনো সিগন্যাল লাভের নিশ্চয়তা নয়।

## লোকাল রান (ডকার ছাড়া)

```bash
bun install
bun run db:push
bun run dev                          # Next.js :3000 (টার্মিনাল ১)
cd mini-services/qx-engine && bun run dev   # ইঞ্জিন :3003 (টার্মিনাল ২)
# ব্রাউজারে http://localhost:3000 (dev প্রক্সি ছাড়া socket.io-এর জন্য
# Caddyfile-এর গেটওয়ে লাগবে — সহজ পথ: docker compose বা Railway ব্যবহার করুন)
```

সম্পূর্ণ লোকাল স্ট্যাক (গেটওয়ে সহ):

```bash
docker build -t qx-signal .
docker run --rm -p 8080:8080 -e PORT=8080 -v qxdata:/data qx-signal
# খুলুন: http://localhost:8080
```
