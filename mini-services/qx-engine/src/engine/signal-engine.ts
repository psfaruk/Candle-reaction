import type { Candle, PairDef, Reason, SignalEvaluation, Zone } from '../types';
import { detectZones, atrPips } from './levels';
import { analyzeStructure } from './structure';
import { analyzePattern } from './patterns';

// ============ Signal Engine — Confluence Model ============
// লেভেল/জোন + মার্কেট স্ট্রাকচার + ক্যান্ডেল ফুল ক্লোজ + রিয়েকশন = আসল কনফার্মেশন
//
// Evaluation happens ONLY at a full candle close (never mid-candle).
// The emitted signal predicts the NEXT 1-minute candle (binary CALL/PUT).
// Pure function over candles[0..last] — identical code path for live
// signals and walk-forward backtesting (no look-ahead bias).

const MAX = { ZONE: 30, STRUCTURE: 25, PATTERN: 30, TICK: 15 };

interface SideScore {
  score: number;
  reasons: Reason[];
  veto: string | null;
}

export interface EvalArgs {
  candles: readonly Candle[];
  last: number; // index of the just-CLOSED candle
  def: PairDef;
}

export function evaluateSignal(args: EvalArgs): SignalEvaluation | null {
  const { candles, last, def } = args;
  if (last < 25) return null; // warmup
  const hist = candles.slice(Math.max(0, last - 159), last + 1);
  const c = candles[last];
  const pip = def.pip;

  const atr = atrPips(hist, pip);
  if (atr < 0.4) return null; // dead market
  const zones = detectZones(hist, pip, c.close);
  const structure = analyzeStructure(hist, pip);
  const pat = analyzePattern(candles, last, pip);

  // outlier / exhaustion guards
  if (pat.rangePips > atr * 3.2) return null;

  const call = scoreSide('CALL', c, zones, structure, pat, atr, pip, def);
  const put = scoreSide('PUT', c, zones, structure, pat, atr, pip, def);

  const best = call.score >= put.score ? call : put;
  if (best.score < 55) return null;
  return { direction: call.score >= put.score ? 'CALL' : 'PUT', score: Math.round(best.score), reasons: best.reasons };
}

function scoreSide(
  dir: 'CALL' | 'PUT',
  c: Candle,
  zones: Zone[],
  st: ReturnType<typeof analyzeStructure>,
  pat: ReturnType<typeof analyzePattern>,
  atr: number,
  pip: number,
  def: PairDef,
): SideScore {
  const reasons: Reason[] = [];
  const wantBull = dir === 'CALL';
  const reasons_fmt = (s: string) => s; // Bengali strings inline

  // ---------- A. লেভেল / জোন (max 30) ----------
  const tol = Math.max(atr * 0.28, 2.2);
  const relevantZones = zones.filter((z) => (wantBull ? z.side === 'SUPPORT' : z.side === 'RESISTANCE'));
  let zonePts = 0;
  let zoneDetail = '';
  let swept = false;

  const extreme = wantBull ? c.low : c.high;
  const zone = relevantZones
    .map((z) => ({ z, dist: (wantBull ? extreme - z.price : z.price - extreme) / pip }))
    .sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0];

  if (zone) {
    const touched = zone.dist <= tol;
    swept = wantBull ? c.close < zone.z.price - atr * 0.5 : c.close > zone.z.price + atr * 0.5;
    if (touched && !swept) {
      // wick reached the zone but candle closed back — classic reaction
      zonePts = 16 + Math.min(10, zone.z.strength * 2);
      zoneDetail = `${wantBull ? 'সাপোর্ট' : 'রেজিস্ট্যান্স'} জোন ${zone.z.price.toFixed(def.digits)} (${zone.z.kind === 'round' ? 'রাউন্ড লেভেল' : 'সুইং জোন'}, শক্তি ${zone.z.strength}) টাচ করে ${
        wantBull ? 'উপরে' : 'নিচে'
      } ক্লোজ`;
      // sweep reversal bonus: price pierced the zone but closed back inside
      const pierced = wantBull ? c.low < zone.z.price - atr * 0.25 : c.high > zone.z.price + atr * 0.25;
      if (pierced) {
        zonePts = Math.min(MAX.ZONE, zonePts + 6);
        zoneDetail += ' — জোন ভেদ করে ফিরে এসেছে (স্টপ-হান্ট সুইপ)';
      }
    } else if (swept) {
      zonePts = 0;
      zoneDetail = 'জোন ভেদ করে ক্লোজ — ব্রেকআউট ঝুঁকি';
    } else {
      zonePts = 0;
      zoneDetail = `নিকটতম জোন থেকে দূরত্ব ${Math.abs(zone.dist).toFixed(1)} পিপ`;
    }
  }
  if (zonePts > 0) reasons.push({ name: 'লেভেল/জোন', detail: zoneDetail, points: zonePts });

  // ---------- B. মার্কেট স্ট্রাকচার (max 25) ----------
  let structPts = 0;
  const structBits: string[] = [];
  if (wantBull) {
    if (st.trend === 'UP') { structPts += 15; structBits.push('আপট্রেন্ড (EMA9>EMA21)'); }
    else if (st.trend === 'RANGE') { structPts += 10; structBits.push('রেঞ্জ মার্কেট'); }
    else structBits.push('ডাউনট্রেন্ড — কাউন্টার-ট্রেন্ড ঝুঁকি');
    if (st.swingTrend === 'UP') { structPts += 5; structBits.push('HH/HL সুইং স্ট্রাকচার'); }
    if (st.pullback && st.trend === 'UP') { structPts += 5; structBits.push('পুলব্যাক রিকভারি'); }
  } else {
    if (st.trend === 'DOWN') { structPts += 15; structBits.push('ডাউনট্রেন্ড (EMA9<EMA21)'); }
    else if (st.trend === 'RANGE') { structPts += 10; structBits.push('রেঞ্জ মার্কেট'); }
    else structBits.push('আপট্রেন্ড — কাউন্টার-ট্রেন্ড ঝুঁকি');
    if (st.swingTrend === 'DOWN') { structPts += 5; structBits.push('LH/LL সুইং স্ট্রাকচার'); }
    if (st.pullback && st.trend === 'DOWN') { structPts += 5; structBits.push('পুলব্যাক রিজেকশন'); }
  }
  structPts = Math.min(MAX.STRUCTURE, structPts);
  if (structPts > 0) reasons.push({ name: 'মার্কেট স্ট্রাকচার', detail: structBits.join(' + '), points: structPts });

  // ---------- C. ক্যান্ডেল রিয়েকশন (max 30) ----------
  let patPts = 0;
  const patBits: string[] = [];
  const clvOK = wantBull ? pat.clv >= 0.25 : pat.clv <= -0.25;
  if (clvOK) {
    patPts += 8;
    patBits.push(`ক্লোজ লোকেশন CLV ${pat.clv >= 0 ? '+' : ''}${pat.clv.toFixed(2)}`);
  }
  const wickRatio = wantBull ? pat.lowerWickPips : pat.upperWickPips;
  const wickFrac = wickRatio / (pat.rangePips || 1);
  if (wickFrac >= 0.5) { patPts += 9; patBits.push(`${wantBull ? 'নিচের' : 'উপরের'} উইক ${(wickFrac * 100).toFixed(0)}% — পিন বার রিজেকশন`); }
  else if (wickFrac >= 0.35) { patPts += 6; patBits.push(`${wantBull ? 'নিচের' : 'উপরের'} উইক ${(wickFrac * 100).toFixed(0)}%`); }
  if (wantBull && pat.isEngulfBull) { patPts += 8; patBits.push('বুলিশ এনগালফিং'); }
  if (!wantBull && pat.isEngulfBear) { patPts += 8; patBits.push('বেয়ারিশ এনগালফিং'); }
  if (wantBull && pat.isMarubozu && pat.isBull) { patPts += 5; patBits.push('বুলিশ মারুবোজু (পূর্ণ বডি)'); }
  if (!wantBull && pat.isMarubozu && pat.isBear) { patPts += 5; patBits.push('বেয়ারিশ মারুবোজু (পূর্ণ বডি)'); }
  const lateFlipAgree = wantBull ? pat.lateFlip === 1 : pat.lateFlip === -1;
  if (lateFlipAgree) {
    patPts += 6;
    patBits.push(`শেষ ১০ সেকেন্ডে কালার ফ্লিপ → ${wantBull ? 'গ্রিন' : 'রেড'} (লেট মোমেন্টাম)`);
  }
  patPts = Math.min(MAX.PATTERN, patPts);
  if (patPts > 0) reasons.push({ name: 'ক্যান্ডেল রিয়েকশন', detail: patBits.join(' + '), points: patPts });

  // ---------- D. টিক কনফার্মেশন (max 15) ----------
  let tickPts = 0;
  const tickBits: string[] = [];
  const imb = wantBull ? pat.tickImbalance : -pat.tickImbalance;
  if (imb >= 0.18) { tickPts += Math.min(7, 4 + imb * 6); tickBits.push(`টিক ইমব্যালান্স ${((wantBull ? pat.tickImbalance : -pat.tickImbalance) * 100).toFixed(0)}% ${wantBull ? 'আপ' : 'ডাউন'}`); }
  const mom = wantBull ? pat.lateMomentumPips : -pat.lateMomentumPips;
  if (mom >= atr * 0.25) { tickPts += Math.min(5, (mom / atr) * 3); tickBits.push(`শেষ ১০ সে. মোমেন্টাম ${mom.toFixed(1)} পিপ`); }
  const avgTicks = 60; // typical sim/live ticks per candle
  if (c.ticks >= avgTicks * 1.3) { tickPts += 3; tickBits.push('টিক অ্যাক্টিভিটি বেড়ে গেছে'); }
  tickPts = Math.min(MAX.TICK, Math.round(tickPts));
  if (tickPts > 0) reasons.push({ name: 'টিক কনফার্মেশন', detail: tickBits.join(' + '), points: tickPts });

  // ---------- veto conditions ----------
  let veto: string | null = null;
  if (swept) veto = 'জোন ভেদ করে ক্লোজ — রিয়েকশন বাতিল';
  if (zonePts === 0) veto = veto ?? 'কোনো লেভেল/জোন রিয়েকশন নেই';
  if (wantBull && st.trend === 'DOWN' && zonePts < 20) veto = veto ?? 'শক্ত ডাউনট্রেন্ডে কল সিগন্যাল ঝুঁকিপূর্ণ';
  if (!wantBull && st.trend === 'UP' && zonePts < 20) veto = veto ?? 'শক্ত আপট্রেন্ডে পুট সিগন্যাল ঝুঁকিপূর্ণ';
  if (pat.isDoji && zonePts < 20) veto = veto ?? 'দোজি ক্যান্ডেল — সিদ্ধান্তহীন';

  const score = zonePts + structPts + patPts + tickPts;
  return { score, reasons, veto };
}

// Live preview used inside the RUNNING candle panel (as-if-closed-now scoring)
export function previewRunningScore(
  closedCandles: readonly Candle[],
  pseudoCandle: Candle,
  def: PairDef,
): SignalEvaluation | null {
  const arr = [...closedCandles, pseudoCandle];
  return evaluateSignal({ candles: arr, last: arr.length - 1, def });
}
