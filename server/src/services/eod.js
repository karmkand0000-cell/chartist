// End-of-day back-office: cancel day orders, charges, contract notes, F&O MTM & expiry, T+1, roll-over
import { db } from '../db.js';
import { config } from '../config.js';
import { bad } from '../errors.js';
import { audit, notify } from './audit.js';
import { post } from './funds.js';
import { closeDay, quote, spotForUnderlying, marketStatus } from './market.js';
import { rollDerivatives } from './instruments.js';
import { spotOf } from './market.js';
import { r2, istParts, parseToken, displayName, isDerivative, isOption } from '../../../shared/util.js';
import { events } from './oms.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function runEod(actor, { date = istParts().date, force = false } = {}) {
  if (!force && marketStatus() === 'OPEN') throw bad('Market is open. Run EOD after close.');
  const prev = await db.one('select * from eod_runs where trade_date=$1', [date]);
  if (prev?.status === 'done') throw bad(`EOD for ${date} has already run`);
  const summary = { cancelledOrders: 0, contractNotes: 0, chargesPosted: 0, futuresMtm: 0, expiredSettled: 0, t1Settled: 0, newContracts: 0 };

  // 1. Cancel live DAY orders
  const live = await db.query(`update orders set status='CANCELLED', status_message='Cancelled at end of day', blocked=0, updated_at=now()
    where status in ('OPEN','TRIGGER_PENDING','OPEN_PENDING') and validity='DAY' returning id, user_id`);
  summary.cancelledOrders = live.length;
  for (const o of live) events.emit('order', { userId: o.user_id, order: { id: o.id, status: 'CANCELLED' } });

  // 2. Charges + contract notes per client
  const users = await db.query('select distinct user_id from trades where trade_date=$1', [date]);
  for (const { user_id } of users) {
    await db.tx(async (t) => {
      const trades = await t.query('select * from trades where user_id=$1 and trade_date=$2 order by id', [user_id, date]);
      const tot = trades.reduce((a, tr) => { for (const [k, v] of Object.entries(tr.charges)) a[k] = r2((a[k] || 0) + v); return a; }, {});
      const unposted = trades.filter((tr) => !tr.charges_posted).reduce((a, tr) => a + tr.charges.total, 0);
      if (unposted > 0) {
        await post(t, user_id, 'CHARGES', { debit: unposted, ref: `CN-${date}`, narration: `Brokerage & statutory charges for ${date}` });
        await t.query('update trades set charges_posted=true where user_id=$1 and trade_date=$2', [user_id, date]);
        summary.chargesPosted += unposted;
      }
      const u = await t.one('select * from users where id=$1', [user_id]);
      const number = `CN/${date.replace(/-/g, '')}/${u.ucc || u.id}`;
      const gross = trades.reduce((a, tr) => a + (tr.side === 'SELL' ? 1 : -1) * tr.qty * tr.price, 0);
      const totals = { ...tot, netObligation: r2(gross - (tot.total || 0)), trades: trades.length };
      await t.query(`insert into contract_notes(user_id, trade_date, number, totals, html) values ($1,$2,$3,$4,$5)
        on conflict (user_id, trade_date) do update set totals=excluded.totals, html=excluded.html`, [user_id, date, number, JSON.stringify(totals), contractNoteHtml(u, date, number, trades, totals)]);
      summary.contractNotes++;
    });
  }

  // 3. Futures daily MTM settlement at closing price
  for (const p of await db.query(`select * from positions where qty <> 0 and token like 'NFO:%:FUT' and product='NRML'`)) {
    const close = quote(p.token)?.ltp; if (!close) continue;
    const mtm = r2((close - p.avg) * p.qty);
    await db.tx(async (t) => {
      if (mtm) await post(t, p.user_id, 'MTM', { credit: mtm > 0 ? mtm : 0, debit: mtm < 0 ? -mtm : 0, ref: `MTM-${date}`, narration: `Futures MTM ${displayName(p.token)} @ ${close}` });
      await t.query('update positions set avg=$4, realised = realised + $5 where user_id=$1 and token=$2 and product=$3', [p.user_id, p.token, p.product, close, mtm]);
    });
    summary.futuresMtm++;
  }

  // 4. Expiry: settle derivatives expiring today (or earlier) at intrinsic / final settlement price
  for (const p of await db.query(`select * from positions where qty <> 0 and token like 'NFO:%'`)) {
    const t0 = parseToken(p.token);
    if (t0.expiry > date) continue;
    const spot = spotForUnderlying(t0.underlying);
    const settle = t0.type === 'FUT' ? spot : Math.max(0, t0.type === 'CE' ? spot - t0.strike : t0.strike - spot);
    await db.tx(async (t) => {
      const pnl = r2((settle - p.avg) * p.qty);
      if (isOption(p.token)) {
        const value = r2(settle * Math.abs(p.qty));
        if (value) await post(t, p.user_id, 'EXPIRY', p.qty > 0 ? { credit: value, narration: `Expiry exercise ${displayName(p.token)} @ ${r2(settle)}` } : { debit: value, narration: `Expiry assignment ${displayName(p.token)} @ ${r2(settle)}` });
      } else if (pnl) await post(t, p.user_id, 'EXPIRY', { credit: pnl > 0 ? pnl : 0, debit: pnl < 0 ? -pnl : 0, narration: `Futures final settlement ${displayName(p.token)}` });
      await t.query('update positions set qty=0, realised = realised + $4, updated_at=now() where user_id=$1 and token=$2 and product=$3', [p.user_id, p.token, p.product, pnl]);
      await notify(p.user_id, 'Contract expired', `${displayName(p.token)} settled at ${r2(settle)}. P&L ₹${pnl}`, t);
    });
    summary.expiredSettled++;
  }

  // 5. Settlement: T+1 shares become free holdings, sell proceeds become withdrawable
  summary.t1Settled = (await db.query('update holdings set qty = qty + t1_qty, t1_qty = 0 where t1_qty > 0 returning user_id')).length;
  await db.query('update accounts set unsettled_credit = 0, fno_day_loss = 0');

  // 6. Roll positions: drop closed lines, reset day buy/sell, carry NRML
  await db.query('delete from positions where qty = 0');
  await db.query(`update positions set buy_qty=0, buy_value=0, sell_qty=0, sell_value=0, realised=0`);

  // 7. Market data: candles, previous close, circuits; new derivative contracts; expire GTTs
  await closeDay(date);
  summary.newContracts = await rollDerivatives(spotOf, new Date(Date.now() + 12 * 3600 * 1000));
  await db.query(`update gtts set status='EXPIRED' where status='ACTIVE' and expires_at < now()`);

  await db.query(`insert into eod_runs(trade_date, status, summary, run_by) values ($1,'done',$2,$3) on conflict (trade_date) do update set status='done', summary=excluded.summary`, [date, JSON.stringify(summary), actor?.id || null]);
  await audit(actor, 'eod_run', 'eod', date, summary);
  return summary;
}

function contractNoteHtml(u, date, number, trades, totals) {
  const rows = trades.map((t) => `<tr><td>${esc(t.exchange_trade_id)}</td><td>${new Date(t.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>${esc(displayName(t.token))}</td><td>${t.side}</td><td>${t.product}</td><td class=r>${t.qty}</td><td class=r>${t.price.toFixed(2)}</td><td class=r>${(t.qty * t.price).toFixed(2)}</td></tr>`).join('');
  const c = (k) => (totals[k] || 0).toFixed(2);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Contract Note ${esc(number)}</title><style>body{font:13px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:5px 7px;text-align:left}.r{text-align:right}.muted{color:#555}</style></head><body>
<h1>${esc(config.brokerName)} — Contract Note cum Bill</h1><p class="muted">SEBI Reg. No. ${esc(config.sebiReg)}</p>
<p><b>Contract note no.:</b> ${esc(number)}<br><b>Trade date:</b> ${date}<br><b>Client:</b> ${esc(u.name)} (UCC ${esc(u.ucc || '-')})</p>
<table><thead><tr><th>Trade no.</th><th>Time</th><th>Security</th><th>B/S</th><th>Product</th><th class=r>Qty</th><th class=r>Rate</th><th class=r>Value</th></tr></thead><tbody>${rows}</tbody></table>
<table><tbody><tr><td>Brokerage</td><td class=r>${c('brokerage')}</td></tr><tr><td>STT</td><td class=r>${c('stt')}</td></tr><tr><td>Exchange transaction charges</td><td class=r>${c('exchange')}</td></tr><tr><td>SEBI turnover fees</td><td class=r>${c('sebi')}</td></tr><tr><td>Stamp duty</td><td class=r>${c('stamp')}</td></tr><tr><td>GST (18%)</td><td class=r>${c('gst')}</td></tr><tr><td>DP charges</td><td class=r>${c('dp')}</td></tr><tr><th>Total charges</th><th class=r>${c('total')}</th></tr><tr><th>Net amount receivable (+) / payable (−)</th><th class=r>${(totals.netObligation || 0).toFixed(2)}</th></tr></tbody></table>
<p class="muted">This is a system-generated contract note. Simulator environment — trades were not executed on any exchange.</p></body></html>`;
}

// Daily scheduler: run EOD automatically at 16:00 IST on weekdays
let schedTimer = null;
export function startEodScheduler() {
  clearInterval(schedTimer);
  schedTimer = setInterval(async () => {
    const { date, hm, weekday } = istParts();
    if (['Sat', 'Sun'].includes(weekday) || hm < '16:00') return;
    if (await db.one('select 1 from eod_runs where trade_date=$1', [date])) return;
    try { console.log('Auto EOD', date, await runEod(null, { date })); } catch (e) { console.error('Auto EOD failed', e.message); }
  }, 60_000);
  schedTimer.unref?.();
}
export { isDerivative };
