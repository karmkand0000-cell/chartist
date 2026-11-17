import { bad } from '../errors.js';
import { allInstruments, expiriesFor, DERIV } from '../services/instruments.js';
import { quote, spotForUnderlying } from '../services/market.js';
import { bs, smileIV, yearsTo } from '../../../shared/options.js';
import { r2 } from '../../../shared/util.js';

export function chainFor(u, expiry) {
  if (!DERIV[u]) throw bad('Unknown underlying');
  const exps = expiriesFor(u);
  expiry = exps.includes(expiry) ? expiry : exps[0];
  const spot = spotForUnderlying(u);
  const T = yearsTo(expiry);
  const byStrike = {};
  for (const i of allInstruments()) {
    if (i.underlying !== u || i.expiry !== expiry || i.type === 'FUT' || !i.active) continue;
    const K = Number(i.strike);
    const q = quote(i.token);
    const sigma = smileIV(spot, K);
    const g = bs({ S: spot, K, T, sigma, type: i.type });
    const dist = Math.abs(K - spot) / (DERIV[u].step * 5);
    const oi = Math.round(150000 * Math.exp(-dist) * (i.type === 'CE' ? (K >= spot ? 1.25 : 0.55) : (K <= spot ? 1.4 : 0.6)));
    (byStrike[K] ||= { strike: K, iv: r2(sigma * 100) })[i.type] = { token: i.token, ltp: q.ltp, change: q.change, pct: q.pct, oi, delta: r2(g.delta), gamma: +g.gamma.toFixed(5), theta: r2(g.theta), vega: r2(g.vega) };
  }
  const rows = Object.values(byStrike).filter((r) => r.CE && r.PE).sort((a, b) => a.strike - b.strike);
  const atm = rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), rows[0]?.strike);
  const pcr = r2(rows.reduce((a, r) => a + r.PE.oi, 0) / Math.max(1, rows.reduce((a, r) => a + r.CE.oi, 0)));
  let maxPain = null, best = Infinity;
  for (const r of rows) {
    const loss = rows.reduce((a, x) => a + x.CE.oi * Math.max(0, r.strike - x.strike) + x.PE.oi * Math.max(0, x.strike - r.strike), 0);
    if (loss < best) { best = loss; maxPain = r.strike; }
  }
  const fut = allInstruments().find((i) => i.underlying === u && i.type === 'FUT' && i.active);
  return { underlying: u, spot, expiry, expiries: exps, atm, pcr, maxPain, daysToExpiry: Math.ceil(T * 365), lot: rows.length ? allInstruments().find((i) => i.underlying === u)?.lot : null, future: fut ? { token: fut.token, ...quote(fut.token) } : null, rows,
    note: 'Simulator: premiums are Black-Scholes values from the index level; OI is modelled.' };
}
