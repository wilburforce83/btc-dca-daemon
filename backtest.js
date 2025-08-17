// backtest.js
// Run: node backtest.js
import 'dotenv/config';
import axios from 'axios';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import {
  classifyRegime, isMassivelyBearish,
  evalBullishFastDaily,
  evalSidewaysDailyPlus4h,
  evalBearMassiveDaily,
  evalBearNormalDailyPlus4h,
  maxWaitDaysFor
} from './technicalTriggers/marketType.js';

dayjs.extend(utc);

// ---------- Config ----------
const PAIR_REST    = process.env.PAIR || 'XXBTZGBP';
const YEARS        = Number(process.env.BACKTEST_YEARS || 2);
const DEPOSIT_GBP  = Number(process.env.BACKTEST_DEPOSIT || 100);
const FEE_BUFFER   = Number(process.env.FEE_BUFFER || 0.0015);
const BUY_DAY      = Number(process.env.BACKTEST_BUY_DAY || 25);
const BUY_TIME_UTC = process.env.BACKTEST_BUY_TIME || '12:00';
const KRAKEN_BASE  = process.env.KRAKEN_BASE || 'https://api.kraken.com';

// ---------- Helpers ----------
function tsSec(d) { return Math.floor(d.valueOf() / 1000); }
function parseHhmm(s) { const [H,M] = s.split(':').map(Number); return { H, M }; }
function round(n, p=2) { return Number(n).toFixed(p); }

async function getOHLC(pair, intervalMinutes, sinceSec) {
  const url = `${KRAKEN_BASE}/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}${sinceSec ? `&since=${sinceSec}` : ''}`;
  const { data } = await axios.get(url);
  if (data.error && data.error.length) throw new Error(data.error.join(', '));
  const key = Object.keys(data.result).find(k => k !== 'last');
  return data.result[key].map(([time, open, high, low, close, vwap, volume]) => ({
    time: time * 1000,
    open: +open, high: +high, low: +low, close: +close, volume: +volume
  }));
}
function nearestCandleAtTime(candles, targetDate, intervalMinutes) {
  const t = targetDate.valueOf();
  return candles.find(c => t >= c.time && t < c.time + intervalMinutes * 60 * 1000)
      || candles.reduce((prev, cur) => Math.abs(cur.time - t) < Math.abs((prev?.time ?? Infinity) - t) ? cur : prev, null);
}
function findDailyByDate(candlesDaily, d) {
  const start = dayjs.utc(dayjs.utc(d).format('YYYY-MM-DD')).valueOf();
  const end = start + 24*3600*1000;
  return candlesDaily.find(c => c.time >= start && c.time < end);
}

// ---------- Main ----------
(async function main() {
  const end = dayjs.utc();
  const start = end.subtract(YEARS, 'year');
  const sinceSec = tsSec(start);

  console.log(`Fetching history from ${start.format()} to ${end.format()}...`);
  const daily = await getOHLC(PAIR_REST, 1440, sinceSec);
  const fourH = await getOHLC(PAIR_REST, 240, sinceSec);

  if (daily.length < 260) throw new Error('Not enough daily history returned.');
  if (fourH.length < 300) throw new Error('Not enough 4h history returned.');

  const dailyClosesAll = daily.map(d => d.close);

  // Build monthly anchors
  const anchors = [];
  let cursor = dayjs.utc(start).startOf('month');
  const { H, M } = parseHhmm(BUY_TIME_UTC);
  while (cursor.isBefore(end)) {
    const anchor = cursor.date(BUY_DAY).hour(H).minute(M).second(0).millisecond(0);
    if (anchor.isAfter(start) && anchor.isBefore(end)) anchors.push(anchor);
    cursor = cursor.add(1, 'month');
  }
  if (!anchors.length) throw new Error('No monthly anchors generated for the chosen window.');

  // DCA baseline
  let dcaBtc = 0, dcaGbp = 0;
  for (const a of anchors) {
    const c = nearestCandleAtTime(fourH, a, 240);
    if (!c) continue;
    const price = c.close;
    const btc = (DEPOSIT_GBP / price) * (1 - FEE_BUFFER);
    dcaBtc += btc; dcaGbp += DEPOSIT_GBP;
  }

  // Trigger strategy
  let trigBtc = 0, trigGbp = 0;

  for (const a of anchors) {
    const anchorDaily = findDailyByDate(daily, a);
    if (!anchorDaily) continue;

    const dailyUpTo = daily.filter(d => d.time <= anchorDaily.time);
    const dailyClosesUpTo = dailyUpTo.map(d => d.close);
    const regime = classifyRegime(dailyClosesUpTo);
    const massiveBear = (regime === 'bearish') && isMassivelyBearish(dailyClosesUpTo);

    const maxDays   = maxWaitDaysFor(regime);
    const windowEnd = a.add(maxDays, 'day');

    let executed = false;

    // Walk forward day-by-day through the window and use the shared evaluators
    for (const d of daily) {
      const t = dayjs.utc(d.time);
      if (t.isBefore(a)) continue;
      if (t.isAfter(windowEnd)) break;

      const idx = daily.findIndex(x => x.time === d.time);
      const closesSlice = dailyClosesAll.slice(0, idx + 1);
      const fourHUpTo   = fourH.filter(c => c.time <= d.time).map(c => c.close);

      let res;
      if (regime === 'bullish') {
        res = evalBullishFastDaily(closesSlice);
      } else if (regime === 'sideways') {
        res = evalSidewaysDailyPlus4h(closesSlice, fourHUpTo);
      } else {
        res = massiveBear
          ? evalBearMassiveDaily(closesSlice)
          : evalBearNormalDailyPlus4h(closesSlice, fourHUpTo);
      }

      if (res.ok) {
        const price = d.close;
        const btc   = (DEPOSIT_GBP / price) * (1 - FEE_BUFFER);
        trigBtc += btc; trigGbp += DEPOSIT_GBP;
        executed = true;
        break;
      }
    }

    // Fallback at window end (daily close) if not executed
    if (!executed) {
      const d =
        daily.find(x => dayjs.utc(x.time).isSame(windowEnd, 'day')) ||
        daily.find(x => dayjs.utc(x.time).isAfter(windowEnd)) ||
        daily[daily.length - 1];
      const price = d.close;
      const btc   = (DEPOSIT_GBP / price) * (1 - FEE_BUFFER);
      trigBtc += btc; trigGbp += DEPOSIT_GBP;
    }
  }

  // ---------- Results ----------
  const finalPrice = daily.at(-1).close;

  const dcaFinalValue  = dcaBtc * finalPrice;
  const trigFinalValue = trigBtc * finalPrice;

  console.log('\n=== Backtest Summary ===');
  console.log(`Period: ${YEARS} years  |  Deposits: £${DEPOSIT_GBP} / month  |  Fee buffer: ${(FEE_BUFFER*100).toFixed(2)}%`);
  console.log(`Anchors tested: ${anchors.length}\n`);

  console.log('DCA @ 25th 12:00 UTC:');
  console.log(`  Total invested: £${round(anchors.length * DEPOSIT_GBP)}`);
  console.log(`  BTC accumulated: ${round(dcaBtc, 6)}`);
  console.log(`  Final price:     £${round(finalPrice)}`);
  console.log(`  Final value:     £${round(dcaFinalValue)}\n`);

  console.log('Trigger strategy (regime-aware, shared):');
  console.log(`  Total invested:  £${round(anchors.length * DEPOSIT_GBP)}`);
  console.log(`  BTC accumulated: ${round(trigBtc, 6)} (${((trigBtc/dcaBtc - 1)*100).toFixed(2)}% vs DCA)`);
  console.log(`  Final price:     £${round(finalPrice)}`);
  console.log(`  Final value:     £${round(trigFinalValue)} (${((trigFinalValue/dcaFinalValue - 1)*100).toFixed(2)}% vs DCA)\n`);
})();
