// Funds: ledger postings, margin/available computation, pay-in & pay-out requests
import { db } from '../db.js';
import { bad, notFound } from '../errors.js';
import { audit, notify } from './audit.js';
import { getSetting } from './settings.js';
import { ltpOf, spotForUnderlying } from './market.js';
import { derivativesMargin, equityMargin } from '../../../shared/margin.js';
import { r2, istParts, isDerivative, isOption } from '../../../shared/util.js';

export async function post(h, userId, type, { debit = 0, credit = 0, ref = null, narration = '' }) {
  debit = r2(debit); credit = r2(credit);
  if (!debit && !credit) return null;
  const a = await h.one('update accounts set cash = cash - $2 + $3, updated_at = now() where user_id=$1 returning cash', [userId, debit, credit]);
  return h.one('insert into ledger(user_id, entry_date, type, debit, credit, balance, ref, narration) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
    [userId, istParts().date, type, debit, credit, a.cash, ref, narration]);
}

// Margin used by open positions (hypothetical override lets RMS test an order before placing it)
export function positionsMargin(positions, override) {
  const m = getSetting('margin');
  const list = override || positions;
  let eq = 0;
  for (const p of list) if (!isDerivative(p.token) && p.product === 'MIS' && p.qty) eq += equityMargin({ side: p.qty > 0 ? 'BUY' : 'SELL', product: 'MIS', qty: Math.abs(p.qty), price: ltpOf(p.token) || p.avg }, m);
  // Option premiums move through the ledger, so option legs carry avg 0 here (risk only)
  const der = derivativesMargin(list.filter((p) => isDerivative(p.token)).map((p) => ({ ...p, avg: isOption(p.token) ? 0 : p.avg })),
    (u) => spotForUnderlying(u), m);
  return r2(eq + der);
}

export function unrealised(p) {
  if (!p.qty) return 0;
  const ltp = ltpOf(p.token) || p.avg;
  return r2((ltp - p.avg) * p.qty);
}

export async function margins(userId, h = db) {
  const acc = await h.one('select * from accounts where user_id=$1', [userId]);
  const positions = await h.query('select * from positions where user_id=$1 and qty <> 0', [userId]);
  const blocked = (await h.one(`select coalesce(sum(blocked),0) b from orders where user_id=$1 and status in ('OPEN','TRIGGER_PENDING','OPEN_PENDING','AMO_REQ_RECEIVED','PUT_ORDER_REQ_RECEIVED')`, [userId])).b;
  const accrued = (await h.one('select coalesce(sum((charges->>\'total\')::numeric),0) c from trades where user_id=$1 and not charges_posted', [userId])).c;
  const payoutHold = (await h.one(`select coalesce(sum(amount),0) a from fund_requests where user_id=$1 and kind='PAYOUT' and status='pending'`, [userId])).a;
  const used = positionsMargin(positions);
  // Long option MTM is not counted (premium already paid); losses on everything else reduce available
  const mtm = positions.reduce((a, p) => a + (isOption(p.token) && p.qty > 0 ? 0 : unrealised(p)), 0);
  const available = r2(acc.cash - blocked - used - accrued - payoutHold + Math.min(0, mtm));
  return {
    cash: acc.cash, openOrders: r2(blocked), usedMargin: used, accruedCharges: r2(accrued), payoutHold: r2(payoutHold), mtm: r2(mtm),
    available, withdrawable: r2(Math.max(0, Math.min(available, acc.cash - acc.unsettled_credit - used - blocked - accrued - payoutHold))),
    unsettledCredit: acc.unsettled_credit, fnoLossLimit: acc.fno_loss_limit, fnoDayLoss: acc.fno_day_loss, fnoPaused: acc.fno_paused,
    maxOrderValue: acc.max_order_value, tradingBlocked: acc.trading_blocked,
  };
}

export async function requestPayin(user, { amount, method = 'UPI', utr }) {
  amount = r2(Number(amount));
  if (!(amount >= 100 && amount <= 1e8)) throw bad('Amount must be between ₹100 and ₹10 crore');
  if (!utr || !/^[A-Za-z0-9]{8,30}$/.test(String(utr))) throw bad('Enter the UPI / bank transaction reference (UTR)');
  if (await db.one(`select 1 from fund_requests where utr=$1 and status <> 'rejected'`, [utr])) throw bad('This UTR has already been submitted');
  // Production: integrate a payment gateway / bank virtual account so pay-ins are confirmed automatically
  const r = await db.one(`insert into fund_requests(user_id, kind, amount, method, utr) values ($1,'PAYIN',$2,$3,$4) returning *`, [user.id, amount, method, utr]);
  await audit(user, 'payin_requested', 'fund_request', r.id, { amount });
  return r;
}

export async function requestPayout(user, { amount }) {
  amount = r2(Number(amount));
  if (!(amount >= 1)) throw bad('Enter a valid amount');
  const m = await margins(user.id);
  if (amount > m.withdrawable) throw bad(`Maximum withdrawable now is ₹${m.withdrawable.toLocaleString('en-IN')}. Sell proceeds become withdrawable after settlement (T+1).`);
  const r = await db.one(`insert into fund_requests(user_id, kind, amount, method) values ($1,'PAYOUT',$2,'BANK') returning *`, [user.id, amount]);
  await audit(user, 'payout_requested', 'fund_request', r.id, { amount });
  return r;
}

export async function cancelRequest(user, id) {
  const r = await db.one(`update fund_requests set status='cancelled' where id=$1 and user_id=$2 and status='pending' returning *`, [id, user.id]);
  if (!r) throw bad('Request cannot be cancelled');
}

export async function processRequest(admin, id, { action, remarks }, ip) {
  return db.tx(async (t) => {
    const r = await t.one('select * from fund_requests where id=$1', [id]);
    if (!r) throw notFound();
    if (r.status !== 'pending') throw bad('Request already processed');
    if (action === 'approve') {
      if (r.kind === 'PAYIN') await post(t, r.user_id, 'PAYIN', { credit: r.amount, ref: `FR${r.id}`, narration: `Funds added via ${r.method} (UTR ${r.utr})` });
      else {
        const acc = await t.one('select cash from accounts where user_id=$1', [r.user_id]);
        if (acc.cash < r.amount) throw bad('Insufficient balance for payout');
        await post(t, r.user_id, 'PAYOUT', { debit: r.amount, ref: `FR${r.id}`, narration: 'Funds withdrawn to bank' });
      }
      await t.query(`update fund_requests set status='approved', processed_by=$2, processed_at=now(), remarks=$3 where id=$1`, [id, admin.id, remarks || null]);
      await notify(r.user_id, r.kind === 'PAYIN' ? 'Funds added' : 'Withdrawal processed', `₹${r.amount.toLocaleString('en-IN')} ${r.kind === 'PAYIN' ? 'credited to your trading account' : 'sent to your bank account'}.`, t);
    } else if (action === 'reject') {
      await t.query(`update fund_requests set status='rejected', processed_by=$2, processed_at=now(), remarks=$3 where id=$1`, [id, admin.id, remarks || 'Rejected']);
      await notify(r.user_id, `${r.kind === 'PAYIN' ? 'Pay-in' : 'Withdrawal'} rejected`, remarks || '', t);
    } else throw bad('Invalid action');
    await audit(admin, `fund_${action}`, 'fund_request', id, { kind: r.kind, amount: r.amount }, ip, t);
    return t.one('select * from fund_requests where id=$1', [id]);
  });
}
