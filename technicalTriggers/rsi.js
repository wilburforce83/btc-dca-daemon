import { RSI } from 'technicalindicators';

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const out = RSI.calculate({ period, values });
  return out[out.length - 1]; // latest
}
