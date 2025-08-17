import { EMA } from 'technicalindicators';

export function ema(values, period) {
  if (values.length < period + 1) return null;
  const out = EMA.calculate({ period, values });
  return out[out.length - 1];
}

export function emaCrossFastOverSlow(values, fast = 9, slow = 21) {
  if (values.length < slow + 2) return { crossed: false };
  const fastArr = EMA.calculate({ period: fast, values });
  const slowArr = EMA.calculate({ period: slow, values });
  const n = Math.min(fastArr.length, slowArr.length);
  if (n < 2) return { crossed: false };
  const f1 = fastArr[n - 1], s1 = slowArr[n - 1];
  const f0 = fastArr[n - 2], s0 = slowArr[n - 2];
  return { crossed: f0 <= s0 && f1 > s1, f1, s1, f0, s0 };
}
