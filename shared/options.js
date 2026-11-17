// Options maths: Black-Scholes, Greeks, volatility smile, expiries, payoff
import { r2, istParts } from './util.js';

export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
const normPdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

export function bs({ S, K, T, r = 0.065, sigma, type }) {
  if (T <= 0) return { price: Math.max(0, type === 'CE' ? S - K : K - S), delta: type === 'CE' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0 };
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  const disc = Math.exp(-r * T);
  const price = type === 'CE' ? S * normCdf(d1) - K * disc * normCdf(d2) : K * disc * normCdf(-d2) - S * normCdf(-d1);
  const thetaY = type === 'CE'
    ? -S * normPdf(d1) * sigma / (2 * sq) - r * K * disc * normCdf(d2)
    : -S * normPdf(d1) * sigma / (2 * sq) + r * K * disc * normCdf(-d2);
  return { price: Math.max(0.05, price), delta: type === 'CE' ? normCdf(d1) : normCdf(d1) - 1, gamma: normPdf(d1) / (S * sigma * sq), theta: thetaY / 365, vega: S * normPdf(d1) * sq / 100 };
}

export function smileIV(S, K, base = 0.13) {
  const m = Math.log(K / S);
  return Math.max(0.06, base + 0.9 * m * m - 0.12 * m);
}

export function yearsTo(expiry, now = new Date()) {
  return Math.max(0, (new Date(`${expiry}T15:30:00+05:30`).getTime() - now.getTime()) / (365 * 24 * 3600 * 1000));
}

// Next n weekly expiries on a weekday (2 = Tuesday) in IST
export function weeklyExpiries(n = 3, weekday = 2, now = new Date()) {
  const { date: today, hm } = istParts(now);
  const d = new Date(`${today}T12:00:00Z`);
  const out = [];
  while (out.length < n) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === weekday && (iso > today || (iso === today && hm < '15:30'))) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
// Last given weekday of the month for the next n months
export function monthlyExpiries(n = 2, weekday = 2, now = new Date()) {
  const { date: today } = istParts(now);
  const out = [];
  let y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  while (out.length < n) {
    const d = new Date(Date.UTC(y, m + 1, 0));
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    if (iso >= today) out.push(iso);
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

export function optionPremium({ spot, strike, type, expiry, now = new Date(), r = 0.065, baseIV = 0.13 }) {
  return r2(bs({ S: spot, K: strike, T: yearsTo(expiry, now), r, sigma: smileIV(spot, strike, baseIV), type }).price);
}

// legs: [{ type:'CE'|'PE'|'FUT', strike, qty (signed: +buy, -sell), avg }]
export function legsPayoff(legs, S) {
  return legs.reduce((a, l) => a + l.qty * ((l.type === 'FUT' ? S : Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S)) - l.avg), 0);
}
export function payoffCurve(legs, spot, width = 0.08, points = 121) {
  const lo = spot * (1 - width), hi = spot * (1 + width);
  const pts = [];
  for (let i = 0; i < points; i++) { const S = lo + ((hi - lo) * i) / (points - 1); pts.push({ S: r2(S), pnl: r2(legsPayoff(legs, S)) }); }
  const be = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.pnl <= 0 && b.pnl > 0) || (a.pnl >= 0 && b.pnl < 0)) be.push(r2(a.S + ((0 - a.pnl) * (b.S - a.S)) / (b.pnl - a.pnl)));
  }
  const sHi = legsPayoff(legs, hi * 1.5) - legsPayoff(legs, hi), sLo = legsPayoff(legs, lo * 0.5) - legsPayoff(legs, lo);
  const pnls = pts.map((p) => p.pnl);
  return { points: pts, breakevens: be, maxProfit: sHi > 1 || sLo > 1 ? Infinity : Math.max(...pnls), maxLoss: sHi < -1 || sLo < -1 ? -Infinity : Math.min(...pnls) };
}
