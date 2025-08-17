import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.KRAKEN_BASE || 'https://api.kraken.com';
const IS_DRY = process.env.DRY_RUN === '1';

// --- DRY balances (kept in-memory for tests) ---
let dryGBP = Number(process.env.DRY_BALANCE_GBP || 50);
let dryXBT = 0;

// Expose dry balances for debugging/emails if you want
export function getDryBalances() {
  return { ZGBP: dryGBP, XXBT: dryXBT };
}
export function dryConsume(gbpDelta, xbtDelta) {
  dryGBP = Math.max(0, dryGBP - Math.max(0, gbpDelta));
  dryXBT += Math.max(0, xbtDelta);
}

// --- Signing + REST helpers ---
function sign(path, request) {
  const secret = Buffer.from(process.env.KRAKEN_API_SECRET || '', 'base64');
  const message = Buffer.concat([
    Buffer.from(String(request.nonce)),
    Buffer.from(new URLSearchParams(request).toString())
  ]);
  const hash = crypto.createHash('sha256').update(message).digest();
  const hmac = crypto.createHmac('sha512', secret)
    .update(Buffer.concat([Buffer.from(path), hash]))
    .digest('base64');
  return hmac;
}

async function krakenPrivate(path, params = {}) {
  if (IS_DRY) {
    // In DRY mode, private endpoints are not called — emulate needed ones below.
    throw new Error('Private endpoint called in DRY mode without stub: ' + path);
  }
  const nonce = Date.now() * 1000;
  const body = { nonce, ...params };
  const headers = {
    'API-Key': process.env.KRAKEN_API_KEY,
    'API-Sign': sign(path, body),
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const res = await axios.post(
    BASE + path,
    new URLSearchParams(body).toString(),
    { headers }
  );
  if (res.data.error && res.data.error.length) {
    throw new Error(res.data.error.join(', '));
  }
  return res.data.result;
}

async function krakenPublic(path, params = {}) {
  const url = BASE + path + (Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '');
  const res = await axios.get(url);
  if (res.data.error && res.data.error.length) {
    throw new Error(res.data.error.join(', '));
  }
  return res.data.result;
}

// ---- Public helpers ----
export async function getTicker(pair = 'XXBTZGBP') {
  const r = await krakenPublic('/0/public/Ticker', { pair });
  const key = Object.keys(r)[0];
  return {
    ask: parseFloat(r[key].a[0]),
    bid: parseFloat(r[key].b[0]),
    last: parseFloat(r[key].c[0])
  };
}

export async function getOHLC(pair = 'XXBTZGBP', interval = 1440, since) {
  const r = await krakenPublic('/0/public/OHLC', { pair, interval, since });
  const key = Object.keys(r)[0];
  return r[key].map(([time, open, high, low, close, vwap, volume, count]) => ({
    time: time * 1000,
    open: +open, high: +high, low: +low, close: +close, volume: +volume
  }));
}

// --- BALANCE: live or DRY ---
export async function getBalance() {
  if (IS_DRY) {
    // Return balances like Kraken would (stringified numbers, Kraken “ZGBP” code for GBP)
    return { ZGBP: String(dryGBP), XXBT: String(dryXBT) };
  }
  return krakenPrivate('/0/private/Balance');
}

export async function getTradeBalance(asset = 'ZGBP') {
  if (IS_DRY) {
    return { eb: String(dryGBP) }; // “equity balance” rough stub
  }
  return krakenPrivate('/0/private/TradeBalance', { asset });
}

// --- ORDER: live or DRY ---
// For DRY, we return a fake txid and DO NOT actually call Kraken.
// We will subtract dry GBP and add dry BTC from the caller using `dryConsume`.
export async function addOrderMarketBuy(pair, volume) {
  if (IS_DRY) {
    // Simulate Kraken's response shape
    return {
      descr: { order: `[DRY] market buy ${pair} vol=${Number(volume).toFixed(8)}` },
      txid: ['dry-' + Date.now()]
    };
  }
  const params = {
    pair: pair,
    type: 'buy',
    ordertype: 'market',
    volume: Number(volume).toFixed(8)
  };
  return krakenPrivate('/0/private/AddOrder', params);
}

export async function getAssetPairs() {
  return krakenPublic('/0/public/AssetPairs');
}