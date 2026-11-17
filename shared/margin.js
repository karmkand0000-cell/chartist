// Margin model: equity VaR+ELM proxy, futures SPAN proxy, hedge-aware options (min of naked vs defined max loss)
import { r2, parseToken, isDerivative, isOption } from './util.js';
import { legsPayoff } from './options.js';

export const DEFAULT_MARGIN = { misRate: 0.2, futRate: 0.12, optShortRate: 0.12 };

export function equityMargin({ side, product, qty, price }, m = DEFAULT_MARGIN) {
  if (product === 'CNC') return side === 'BUY' ? r2(qty * price) : 0;
  return r2(qty * price * m.misRate);
}

// legs: [{ type, strike, qty (signed), avg }] for ONE underlying+expiry group (options + futures)
export function groupMargin(legs, spot, m = DEFAULT_MARGIN) {
  legs = legs.filter((l) => l.qty !== 0);
  if (!legs.length) return 0;
  const naked = legs.reduce((a, l) => {
    if (l.type === 'FUT') return a + Math.abs(l.qty) * spot * m.futRate;
    return a + (l.qty > 0 ? l.qty * l.avg : -l.qty * (spot * m.optShortRate + l.avg));
  }, 0);
  const lo = spot * 0.6, hi = spot * 1.4;
  const pts = [lo, hi, ...legs.filter((l) => l.strike).map((l) => l.strike).filter((k) => k > lo && k < hi)];
  const minPay = Math.min(...pts.map((S) => legsPayoff(legs, S)));
  const bounded = legsPayoff(legs, hi * 1.2) - legsPayoff(legs, hi) >= -1e-9 && legsPayoff(legs, lo * 0.8) - legsPayoff(legs, lo) >= -1e-9;
  return r2(bounded ? Math.min(naked, Math.max(0, -minPay)) : naked);
}

// positions: [{ token, product, qty, avg }]; spotOf(underlying) → number. Returns total F&O margin.
export function derivativesMargin(positions, spotOf, m = DEFAULT_MARGIN) {
  const groups = {};
  for (const p of positions) {
    if (!isDerivative(p.token) || !p.qty) continue;
    const t = parseToken(p.token);
    (groups[`${t.underlying}|${t.expiry}`] ||= { u: t.underlying, legs: [] }).legs.push({ type: t.type, strike: t.strike, qty: p.qty, avg: p.avg });
  }
  return r2(Object.values(groups).reduce((a, g) => a + groupMargin(g.legs, spotOf(g.u), m), 0));
}
export { isOption };
