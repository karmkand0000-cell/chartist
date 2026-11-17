// Client reports: tradebook, ledger statement, P&L summary, tax P&L categories
import { db } from '../db.js';
import { r2, displayName, isDerivative } from '../../../shared/util.js';

const range = (q) => ({ from: q.from || '2000-01-01', to: q.to || '2999-12-31' });
export async function tradebook(userId, q = {}) {
  const { from, to } = range(q);
  const rows = await db.query('select * from trades where user_id=$1 and trade_date between $2 and $3 order by id desc limit 2000', [userId, from, to]);
  return rows.map((t) => ({ ...t, name: displayName(t.token), value: r2(t.qty * t.price) }));
}
export async function ledgerStatement(userId, q = {}) {
  const { from, to } = range(q);
  return db.query('select * from ledger where user_id=$1 and entry_date between $2 and $3 order by id desc limit 2000', [userId, from, to]);
}
export async function pnl(userId, q = {}) {
  const { from, to } = range(q);
  const rows = await db.query('select * from trades where user_id=$1 and trade_date between $2 and $3', [userId, from, to]);
  const cat = { intraday: 0, delivery: 0, fno: 0, charges: 0, turnoverFno: 0 };
  const byScrip = {};
  for (const t of rows) {
    const k = isDerivative(t.token) ? 'fno' : t.product === 'MIS' ? 'intraday' : 'delivery';
    cat[k] += t.pnl; cat.charges += t.charges.total || 0;
    if (k === 'fno') cat.turnoverFno += Math.abs(t.pnl);
    const s = (byScrip[t.token] ||= { token: t.token, name: displayName(t.token), category: k, pnl: 0, buyQty: 0, sellQty: 0, charges: 0 });
    s.pnl += t.pnl; s.charges += t.charges.total || 0; if (t.side === 'BUY') s.buyQty += t.qty; else s.sellQty += t.qty;
  }
  // Option P&L realised via premium flows: add closed option premium differences
  for (const s of Object.values(byScrip)) { s.pnl = r2(s.pnl); s.charges = r2(s.charges); }
  const out = Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, r2(v)]));
  return { ...out, gross: r2(cat.intraday + cat.delivery + cat.fno), net: r2(cat.intraday + cat.delivery + cat.fno - cat.charges), scrips: Object.values(byScrip),
    taxNote: 'Indicative: intraday equity = speculative business income; F&O = non-speculative business income; delivery = capital gains (STCG/LTCG by holding period). Consult a tax advisor.' };
}
