
import 'dotenv/config';
import { rsi } from './rsi.js';
import { bollinger } from './bb.js';
import { emaCrossFastOverSlow } from './maCross.js';
import { EMA, SMA } from 'technicalindicators';

const BEAR_RSI_MAX            = Number(process.env.BEAR_RSI_MAX ?? 55);
const BEAR_RSI_EARLY          = Number(process.env.BEAR_RSI_EARLY ?? 50);
const BEAR_ALLOW_RSI_ONLY     = (process.env.BEAR_ALLOW_RSI_ONLY ?? 'true') === 'true';
const BEAR_ALLOW_LOWER_BB_ONLY= (process.env.BEAR_ALLOW_LOWER_BB_ONLY ?? 'true') === 'true';
const BEAR_BELOW_SMA_PCT      = Number(process.env.BEAR_BELOW_SMA_PCT ?? 0.07); // 7%

const MASSIVE_BEAR_SMA_FACTOR = Number(process.env.MASSIVE_BEAR_SMA_FACTOR ?? 0.90);

const BULL_RSI_MIN            = Number(process.env.BULL_RSI_MIN ?? 55);
const BULL_PULLBACK_PCT       = Number(process.env.BULL_PULLBACK_PCT ?? 0.015);
const SIDEWAYS_RSI_MAX        = Number(process.env.SIDEWAYS_RSI_MAX ?? 45);

const FAST_EMA                = Number(process.env.FAST_EMA ?? 9);
const SLOW_EMA                = Number(process.env.SLOW_EMA ?? 21);

const BULL_FASTBUY_MAX_WAIT_DAYS = Number(process.env.BULL_FASTBUY_MAX_WAIT_DAYS ?? 4);
const SIDEWAYS_MAX_WAIT_DAYS     = Number(process.env.SIDEWAYS_MAX_WAIT_DAYS ?? 21);
const BEAR_MAX_WAIT_DAYS         = Number(process.env.BEAR_MAX_WAIT_DAYS ?? 30);

// === Load trigger parameters from .env with sensible defaults ===
const RSI_PERIOD     = parseInt(process.env.RSI_PERIOD     || "14");
const RSI_BULL_MAX   = parseFloat(process.env.RSI_BULL_MAX || "55");
const RSI_BEAR_MAX   = parseFloat(process.env.RSI_BEAR_MAX || "45");

const BB_PERIOD      = parseInt(process.env.BB_PERIOD      || "20");
const BB_STDDEV      = parseFloat(process.env.BB_STDDEV    || "2");

const EMA_FAST       = parseInt(process.env.EMA_FAST       || "9");
const EMA_SLOW       = parseInt(process.env.EMA_SLOW       || "21");

const BULL_FASTBUY_DRAWDOWN = parseFloat(process.env.BULL_FASTBUY_DRAWDOWN || "0.015");
const NONBULL_MAX_WAIT_DAYS = parseInt(process.env.NONBULL_MAX_WAIT_DAYS   || "30");

// === Regime classification ===
export function classifyRegime(dailyCloses) {
  if (dailyCloses.length < 200) return 'sideways';

  const last = dailyCloses[dailyCloses.length - 1];
  const ma50 = average(dailyCloses.slice(-50));
  const ma200 = average(dailyCloses.slice(-200));

  if (ma50 > ma200 * 1.02) return 'bullish';
  if (ma50 < ma200 * 0.98) return 'bearish';
  return 'sideways';
}

export function isMassivelyBearish(dailyCloses) {
  if (dailyCloses.length < 200) return false;
  const sma200 = SMA.calculate({ period: 200, values: dailyCloses }).pop();
  const last = dailyCloses.at(-1);
  return last <= sma200 * MASSIVE_BEAR_SMA_FACTOR; // e.g., 0.92 (8% below)
}


// === Buy trigger evaluators ===
export function evalBullishFastDaily(dailyCloses) {
  if (dailyCloses.length < 60) return { ok:false, pretty:`bull: need daily>=60 (${dailyCloses.length})` };

  const last = dailyCloses.at(-1);
  const R = rsi(dailyCloses, RSI_PERIOD);
  const hi10 = Math.max(...dailyCloses.slice(-10));
  const dd = (hi10 - last) / hi10;

  const ok = (R && R < RSI_BULL_MAX) || dd >= BULL_FASTBUY_DRAWDOWN;
  return { ok, pretty:`bull: RSI${RSI_PERIOD}=${R?.toFixed(2) ?? 'n/a'} <${RSI_BULL_MAX}? ${R<RSI_BULL_MAX} | dd10D=${(dd*100).toFixed(2)}% ≥${(BULL_FASTBUY_DRAWDOWN*100).toFixed(2)}%? ${dd>=BULL_FASTBUY_DRAWDOWN}` };
}

export function evalSidewaysDailyPlus4h(dailyCloses, fourHour) {
  if (dailyCloses.length < 60 || fourHour.length < 60) 
    return { ok:false, pretty:`sideways: need daily>=60,4h>=60` };

  const R = rsi(dailyCloses, RSI_PERIOD);
  const BB = bollinger(dailyCloses, BB_PERIOD, BB_STDDEV);
  const lowerHit = !!(BB && dailyCloses.at(-1) <= BB.lower);
  const cross = emaCrossFastOverSlow(fourHour.map(c=>c.close), EMA_FAST, EMA_SLOW);

  const ok = (R && R <= RSI_BEAR_MAX) && lowerHit && cross.crossed;
  return { ok, pretty:`sideways: RSI≤${RSI_BEAR_MAX} ${R<=RSI_BEAR_MAX} | BB lower hit ${lowerHit} | 4h EMA${EMA_FAST}>${EMA_SLOW} ${cross.crossed}` };
}

export function evalBearMassiveDaily(dailyCloses) {
  if (dailyCloses.length < 20) return { ok:false, pretty:`bear(massive): need daily>=20` };
  const R  = rsi(dailyCloses, 14);
  const BB = bollinger(dailyCloses, 20, 2);
  const lowerHit = !!(BB && dailyCloses.at(-1) <= BB.lower);

  const rsiEarly = (R !== null && R <= BEAR_RSI_EARLY);
  const ok = (BEAR_ALLOW_LOWER_BB_ONLY && lowerHit) || (BEAR_ALLOW_RSI_ONLY && rsiEarly);

  return { ok, pretty:`bear(massive): lowerBB=${lowerHit} | RSI≤${BEAR_RSI_EARLY}=${rsiEarly} (no 4h confirm)` };
}


export function evalBearNormalDailyPlus4h(dailyCloses, fourHourCloses) {
  if (dailyCloses.length < 60) return { ok:false, pretty:`bear: need daily>=60` };

  const R   = rsi(dailyCloses, 14);
  const BB  = bollinger(dailyCloses, 20, 2);
  const sma = SMA.calculate({ period: 200, values: dailyCloses }).pop();
  const last = dailyCloses.at(-1);
  const lowerHit = !!(BB && last <= BB.lower);
  const below200 = sma ? (sma - last) / sma : 0;

  // Path A: Early RSI-only buy (no 4h confirm)
  if (BEAR_ALLOW_RSI_ONLY && R !== null && R <= BEAR_RSI_EARLY) {
    return { ok:true, pretty:`bear: early RSI≤${BEAR_RSI_EARLY} (${R.toFixed(2)}), no 4h confirm` };
  }

  // Path B: Lower-BB-only buy (no 4h confirm)
  if (BEAR_ALLOW_LOWER_BB_ONLY && lowerHit) {
    return { ok:true, pretty:`bear: lowerBB touch (no 4h confirm)` };
  }

  // Path C: Value filter: X% below 200-SMA (no 4h confirm)
  if (sma && below200 >= BEAR_BELOW_SMA_PCT) {
    return { ok:true, pretty:`bear: ${(below200*100).toFixed(1)}% below 200SMA ≥ ${(BEAR_BELOW_SMA_PCT*100).toFixed(1)}% (no 4h confirm)` };
  }

  // Path D: Classic confirm — RSI≤BEAR_RSI_MAX AND lowerBB AND 4h EMA cross up
  if (fourHourCloses.length >= Math.max(FAST_EMA, SLOW_EMA) + 2) {
    const cross = emaCrossFastOverSlow(fourHourCloses, FAST_EMA, SLOW_EMA);
    const ok = (R !== null && R <= BEAR_RSI_MAX) && lowerHit && cross.crossed;
    return { ok, pretty:`bear: RSI≤${BEAR_RSI_MAX}=${R<=BEAR_RSI_MAX} | lowerBB=${lowerHit} | 4h EMA${FAST_EMA}>${SLOW_EMA}=${cross.crossed}` };
  }

  return { ok:false, pretty:`bear: waiting (no early/BB/SMA condition, 4h<min)` };
}


export function maxWaitDaysFor() {
  return NONBULL_MAX_WAIT_DAYS; // fixed for now, can be extended later
}

// === Helpers ===
function average(arr) {
  return arr.reduce((a,b)=>a+b,0)/arr.length;
}
