// app.js (refactored to use shared triggers)
import 'dotenv/config';
import fs from 'fs';
import dayjs from 'dayjs';
import tz from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import WebSocket from 'ws';
import {
  getTicker, getOHLC, getBalance,
  addOrderMarketBuy, dryConsume, getDryBalances
} from './kraken.js';

// ⬇️ shared trigger logic
import {
  classifyRegime, isMassivelyBearish,
  evalBullishFastDaily,
  evalSidewaysDailyPlus4h,
  evalBearMassiveDaily,
  evalBearNormalDailyPlus4h,
  maxWaitDaysFor
} from './technicalTriggers/marketType.js';

// You already have these indicator utilities elsewhere in your repo for snapshots:
import { rsi } from './technicalTriggers/rsi.js';
import { bollinger } from './technicalTriggers/bb.js';
import { emaCrossFastOverSlow } from './technicalTriggers/maCross.js';

dayjs.extend(utc);
dayjs.extend(tz);

// ====== CONFIG ======
const TZ = process.env.TIMEZONE || 'Europe/London';
const IS_DRY = process.env.DRY_RUN === '1';

const PAIR = process.env.PAIR || 'XXBTZGBP';
const DISPLAY_PAIR = process.env.DISPLAY_PAIR || 'XBT/GBP';

const CHECK_BALANCE_EVERY_HOURS   = Number(process.env.CHECK_BALANCE_EVERY_HOURS || 4);
const FEE_BUFFER                  = Number(process.env.FEE_BUFFER || 0.0015);
const MIN_GBP_ORDER               = Number(process.env.MIN_GBP_ORDER || 25);
const COOL_DOWN_HOURS             = Number(process.env.COOL_DOWN_HOURS || 24);
const MAX_BUYS_PER_WEEK           = Number(process.env.MAX_BUYS_PER_WEEK || 2);

const STATE_PATH = './state.json';

// ====== STATE ======
let state = loadState();

// Arrays
const daily = [];
const dailyCloses = [];
const fourHour = [];
const oneHour = []; // chart-only (24h)

// ====== INIT ======
init().catch(e => log('FATAL init error:', e.message));

async function init() {
  await seedHistory();
  openWS();
  await balanceLoop();

  const intervalMs = CHECK_BALANCE_EVERY_HOURS * 3600 * 1000;
  setInterval(() => {
    balanceLoop().catch(e => log('balanceLoop error:', e.message));
  }, intervalMs);
}

// ====== HISTORY SEEDING ======
async function seedHistory() {
  const d1 = await getOHLC(PAIR, 1440);
  daily.length = 0; daily.push(...d1.slice(-400));
  dailyCloses.length = 0; dailyCloses.push(...daily.map(c => c.close));

  const h4 = await getOHLC(PAIR, 240);
  fourHour.length = 0; fourHour.push(...h4.slice(-800));

  const h1 = await getOHLC(PAIR, 60);
  oneHour.length = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  oneHour.push(...h1.filter(c => c.time >= cutoff));

  log(`Seeded history → 1D:${daily.length}  4h:${fourHour.length}  1h(24h):${oneHour.length}`);
}

// ====== WEBSOCKET (4h + 1h) ======
let ws;
function openWS() {
  ws = new WebSocket('wss://ws.kraken.com/');
  ws.on('open', () => {
    ws.send(JSON.stringify({ event: 'subscribe', pair: [DISPLAY_PAIR], subscription: { name: 'ohlc', interval: 240 }}));
    ws.send(JSON.stringify({ event: 'subscribe', pair: [DISPLAY_PAIR], subscription: { name: 'ohlc', interval: 60 }}));
    log('Subscribed OHLC WS [4h, 1h].');
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (!Array.isArray(msg) || typeof msg[1] !== 'object') return;
      const ohlc = msg[1]; const interval = msg[2]?.interval;
      if (!interval) return;
      const c = mapCandle(ohlc);
      if (interval === 240) upsert(fourHour, c, 800);
      else if (interval === 60) { upsert(oneHour, c, 2000); prune24h(oneHour); }
    } catch {}
  });
  ws.on('close', () => { log('WS closed → reconnecting in 5s…'); setTimeout(openWS, 5000); });
  ws.on('error', e => { log('WS error:', e.message); try { ws.close(); } catch {} });
}

// ====== MAIN BALANCE/LOGIC LOOP ======
async function balanceLoop() {
  const now = dayjs().tz(TZ);
  const nextCheck = now.add(CHECK_BALANCE_EVERY_HOURS, 'hour').format();
  const monthKey = now.format('YYYY-MM');

  if (state.lastTradeMonth === monthKey) {
    log(`Balance check → already traded this month (${monthKey}). Next check: ${nextCheck}`);
    return;
  }

  const balances = await getBalance();
  const gbp = parseFloat(balances.ZGBP || balances.GBP || '0');
  log(`Balance check → GBP available: £${gbp.toFixed(2)} (DRY=${IS_DRY}). Next check scheduled: ${nextCheck}`);
  if (gbp < MIN_GBP_ORDER) return;

  if (!state.windowStartTs) {
    state.windowStartTs = Date.now();
    saveState();
    log('Opened monthly purchase window.');
  }

  // Regime
  const regime = classifyRegime(dailyCloses);
  const massiveBear = regime === 'bearish' && isMassivelyBearish(dailyCloses);
  const maxDays = maxWaitDaysFor(regime);
  const windowAgeDays = (Date.now() - (state.windowStartTs || Date.now())) / 86400000;

  // Evaluate triggers (shared)
  let triggers;
  if (regime === 'bullish') {
    triggers = evalBullishFastDaily(dailyCloses);
  } else if (regime === 'sideways') {
    triggers = evalSidewaysDailyPlus4h(dailyCloses, fourHour.map(c => c.close));
  } else {
    triggers = massiveBear
      ? evalBearMassiveDaily(dailyCloses)
      : evalBearNormalDailyPlus4h(dailyCloses, fourHour.map(c => c.close));
  }

  log(`[${regime}${massiveBear ? '|massive' : ''}] windowAge=${windowAgeDays.toFixed(2)}d (max ${maxDays}d) → ${triggers.pretty}`);

  if (triggers.ok) {
    await executeBuy(gbp, triggers);
    return;
  }

  if (windowAgeDays >= maxDays) {
    log(`Window expired (${windowAgeDays.toFixed(2)}d ≥ ${maxDays}d) → market buy fallback.`);
    await executeBuy(gbp, { pretty: `[fallback ${regime}${massiveBear ? '|massive' : ''}]` });
  }
}

// ====== BUY & NOTIFY (unchanged) ======
async function executeBuy(gbpAvailable, triggerInfo) {
  const now = Date.now();
  if (state.lastBuyTs && now - state.lastBuyTs < COOL_DOWN_HOURS * 3600 * 1000) {
    log(`Cooldown active (${COOL_DOWN_HOURS}h) → skipping buy.`);
    return;
  }
  const weekKey = dayjs().tz(TZ).format('YYYY-[W]WW');
  if (state.weekKey !== weekKey) { state.weekKey = weekKey; state.weekBuys = 0; }
  if (state.weekBuys >= MAX_BUYS_PER_WEEK) {
    log('Weekly buy cap reached → skipping buy.'); return;
  }

  const { ask } = await getTicker(PAIR);
  const gbpSpend = Math.max(gbpAvailable, 0);
  if (gbpSpend < MIN_GBP_ORDER) { log('Below MIN_GBP_ORDER → skipping.'); return; }
  const volume = (gbpSpend / ask) * (1 - FEE_BUFFER);

  log(`EXECUTE BUY → vol≈${volume.toFixed(6)} BTC @ ~£${ask.toFixed(2)} for £${gbpSpend.toFixed(2)} (fee buf ${(FEE_BUFFER*100).toFixed(2)}%, DRY=${IS_DRY})`);

  const res = await addOrderMarketBuy(PAIR, volume);

  if (IS_DRY) {
    dryConsume(gbpSpend, volume);
    const dry = getDryBalances();
    log(`DRY settlement → GBP=£${Number(dry.ZGBP).toFixed(2)} | XBT=${Number(dry.XXBT).toFixed(6)}`);
  }

  state.lastTradeMonth = dayjs().tz(TZ).format('YYYY-MM');
  state.lastBuyTs = now;
  state.weekBuys = (state.weekBuys || 0) + 1;
  state.windowStartTs = null;
  saveState();

  // === Email + chart snapshot (your existing functions) ===
  const entryTimeMs = Date.now();
  const chartPath = await renderEntryChartPNG({
    candles: oneHour.slice(-48),
    entryTimeMs,
    outDir: '.',
    filename: `entry-${entryTimeMs}.png`
  });

  const snapshotHtml = await indicatorsSnapshotHTML();
  const subject = `BTC BUY @ ~£${ask.toFixed(2)} – ${dayjs(entryTimeMs).tz(TZ).format()}`;
  const html = `
    <h2>BTC Buy Executed (${IS_DRY ? 'DRY RUN' : 'LIVE'})</h2>
    <p><b>Pair:</b> ${PAIR}</p>
    <p><b>GBP spent:</b> £${gbpSpend.toFixed(2)}</p>
    <p><b>Est. volume:</b> ${volume.toFixed(6)} BTC</p>
    <p><b>Ask at entry:</b> £${ask.toFixed(2)}</p>
    <p><b>Tx:</b> ${res?.txid?.join(', ') || 'n/a'}</p>
    <p><b>Trigger note:</b> ${typeof triggerInfo?.pretty === 'string' ? triggerInfo.pretty : JSON.stringify(triggerInfo)}</p>
    <hr/>
    ${snapshotHtml}
  `;
  try {
    const id = await sendTradeEmail({ subject, html, attachmentPath: chartPath });
    log('Email sent:', id);
  } catch (e) { log('Email send failed:', e.message); }
}

async function indicatorsSnapshotHTML() {
  const R1D = rsi(dailyCloses, 14);
  const BB1D = bollinger(dailyCloses, 20, 2);
  const closes4h = fourHour.map(c => c.close);
  const cross4h = emaCrossFastOverSlow(closes4h, 9, 21);
  const bullish = isBullishDaily(dailyCloses);

  const bbString = BB1D
  ? `lower=${BB1D.lower.toFixed(2)}, mid=${BB1D.middle.toFixed(2)}, upper=${BB1D.upper.toFixed(2)}`
  : 'n/a';

return `
  <h3>Indicator Snapshot</h3>
  <ul>
    <li>Market regime: <b>${bullish ? 'Bullish' : 'Not bullish'}</b></li>
    <li>RSI(14, 1D): <b>${R1D !== null ? R1D.toFixed(2) : 'n/a'}</b></li>
    <li>BB(20,2, 1D): <b>${bbString}</b></li>
    <li>EMA(9>21, 4h) crossed: <b>${cross4h.crossed}</b></li>
  </ul>
`;

}

// ====== utils ======
function mapCandle(a) {
  const [time, open, high, low, close, vwap, vol] = a;
  return { time: Number(time) * 1000, open:+open, high:+high, low:+low, close:+close, volume:+vol };
}
function upsert(arr, c, max) {
  const last = arr[arr.length - 1];
  if (last && last.time === c.time) arr[arr.length - 1] = c;
  else arr.push(c);
  if (arr.length > max) arr.splice(0, arr.length - max);
}
function prune24h(arr) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  while (arr.length && arr[0].time < cutoff) arr.shift();
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function saveState() { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function log(...args) { const ts = dayjs().tz(TZ).format('YYYY-MM-DD HH:mm:ss'); console.log(`[${ts}]`, ...args); }
