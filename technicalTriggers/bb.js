import { BollingerBands } from 'technicalindicators';

export function bollinger(values, period = 20, stdDev = 2) {
  if (values.length < period + 1) return null;
  const out = BollingerBands.calculate({ period, values, stdDev });
  return out[out.length - 1]; // { lower, middle, upper, pb }
}
