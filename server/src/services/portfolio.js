// Positions & holdings bookkeeping, applied on every exchange trade
import { db } from '../db.js';
import { post } from './funds.js';
import { quote } from './market.js';
import { getInstrument } from './instruments.js';
import { r2, isDerivative, isOption, displayName } from '../../../shared/util.js';

// Returns realised P&L of this fill
export async function applyTrade(h, tr) {
  const { user_id: uid, token, side, qty, price, product } = tr;
  const value = r2(qty * price);
  const name = displayName(token);
  let pnl = 0;

  if (product === 'CNC') {
    const hd = await h.one('select * from holdings where user_id=$1 and token=$2', [uid, token]) || { qty: 0, t1_qty: 0, avg: 0 };
    if (side === 'BUY') {
      const total = hd.qty + hd.t1_qty;
      const avg = (hd.avg * total + price * qty) / (total + qty);
      await h.query(`insert into holdings(user_id, token, qty, t1_qty, avg) values ($1,$2,0,$3,$4)
        on conflict (user_id, token) do update set t1_qty = holdings.t1_qty + $3, avg = $4`, [uid, token, qty, avg]);
      await post(h, uid, 'BUY', { debit: value, ref: `T${tr.id}`, narration: `Bought ${qty} ${name} @ ${price}` });
    } else {
      pnl = r2((price - hd.avg) * qty);
      const fromFree = Math.min(hd.qty, qty), fromT1 = qty - fromFree;
      await h.query('update holdings set qty = qty - $3, t1_qty = t1_qty - $4 where user_id=$1 and token=$2', [uid, token, fromFree, fromT1]);
      await h.query('delete from holdings where user_id=$1 and token=$2 and qty <= 0 and t1_qty <= 0', [uid, token]);
      await post(h, uid, 'SELL', { credit: value, ref: `T${tr.id}`, narration: `Sold ${qty} ${name} @ ${price}` });
      await h.query('update accounts set unsettled_credit = unsettled_credit + $2 where user_id=$1', [uid, value]);
    }
  } else {
    const p = await h.one('select * from positions where user_id=$1 and token=$2 and product=$3', [uid, token, product])
      || { qty: 0, avg: 0, buy_qty: 0, buy_value: 0, sell_qty: 0, sell_value: 0, realised: 0 };
    const dir = side === 'BUY' ? 1 : -1;
    let q = qty, net = p.qty, avg = Number(p.avg);
    if (net !== 0 && Math.sign(net) === -dir) {
      const close = Math.min(q, Math.abs(net));
      pnl = r2((price - avg) * close * Math.sign(net));
      net += dir * close; q -= close;
      if (net === 0) avg = 0;
    }
    if (q > 0) { avg = (avg * Math.abs(net) + price * q) / (Math.abs(net) + q); net += dir * q; }
    const b = side === 'BUY';
    await h.query(`insert into positions(user_id, token, product, qty, avg, buy_qty, buy_value, sell_qty, sell_value, realised, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      on conflict (user_id, token, product) do update set qty=$4, avg=$5, buy_qty=$6, buy_value=$7, sell_qty=$8, sell_value=$9, realised=$10, updated_at=now()`,
    [uid, token, product, net, r2(avg * 10000) / 10000, p.buy_qty + (b ? qty : 0), r2(p.buy_value + (b ? value : 0)), p.sell_qty + (b ? 0 : qty), r2(p.sell_value + (b ? 0 : value)), r2(p.realised + pnl)]);
    if (isOption(token)) {
      // Option premium is paid / received in full
      if (b) await post(h, uid, 'OPT_BUY', { debit: value, ref: `T${tr.id}`, narration: `Bought ${qty} ${name} @ ${price}` });
      else await post(h, uid, 'OPT_SELL', { credit: value, ref: `T${tr.id}`, narration: `Sold ${qty} ${name} @ ${price}` });
    } else if (pnl) {
      // Equity intraday & futures: realised P&L settles to the ledger
      await post(h, uid, 'PNL', { credit: pnl > 0 ? pnl : 0, debit: pnl < 0 ? -pnl : 0, ref: `T${tr.id}`, narration: `Realised P&L ${name} (${product})` });
    }
    if (isDerivative(token) && pnl < 0) await h.query('update accounts set fno_day_loss = fno_day_loss + $2 where user_id=$1', [uid, -pnl]);
  }
  return pnl;
}

export async function positions(userId) {
  const rows = await db.query('select * from positions where user_id=$1 order by updated_at desc', [userId]);
  return rows.map((p) => {
    const q = quote(p.token);
    const ltp = q?.ltp || p.avg;
    const unreal = p.qty ? r2((ltp - p.avg) * p.qty) : 0;
    const inst = getInstrument(p.token);
    return { ...p, name: displayName(p.token), lot: inst?.lot || 1, ltp, change: q?.pct || 0, unrealised: unreal, pnl: r2(p.realised + unreal) };
  });
}

export async function holdings(userId) {
  const rows = await db.query('select * from holdings where user_id=$1 order by token', [userId]);
  return rows.map((hd) => {
    const q = quote(hd.token);
    const total = hd.qty + hd.t1_qty;
    const ltp = q?.ltp || hd.avg;
    const inst = getInstrument(hd.token);
    return { ...hd, symbol: inst?.symbol, name: inst?.name, sector: inst?.sector, total, ltp, close: q?.close || ltp, invested: r2(total * hd.avg), current: r2(total * ltp), pnl: r2(total * (ltp - hd.avg)), dayPnl: r2(total * (ltp - (q?.close || ltp))), dayPct: q?.pct || 0 };
  });
}
