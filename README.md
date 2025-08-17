# btc-dca-daemon
Simple node JS daemon for placing optimum orders of Bitcoin on the Kraken platform using RSI, BB, and EMA
# BTC DCA Daemon (One Buy Per Month)

## What it does
- Watches your Kraken GBP balance.
- If balance > 0, it enters an entry window (bullish: <=4 days; not-bullish: <=21 days).
- **Bullish**: buys on a small dip (RSI(1h) < 50 OR ~≥1.2% off recent 24h high).
- **Not-bullish**: waits for RSI(1h) ≤ 35 AND lower Bollinger(1h) touch AND EMA(9>21,5m) cross.
- If no trigger by window end, buys at market anyway.
- **Exactly one trade per calendar month**.
- Emails you trade details + a 24h chart PNG at entry.
- Respects cooldown and weekly buy caps.

## Setup
```bash
git clone <this>
cd btc-dca-daemon
cp .env.example .env   # fill in values
npm install
npm run dry            # dry-run to test flows
npm start              # live mode (be careful)
