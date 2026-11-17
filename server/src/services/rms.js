// Risk Management System: pre-trade validation + margin check, post-trade MTM monitoring and auto square-off
import { db } from '../db.js';
import { bad, forbidden } from '../errors.js';
import { getSetting } from './settings.js';
import { getInstrument } from './instruments.js';
import { quote, marketStatus } from './market.js';
import { margins, positionsMargin } from './funds.js';
import { calcCharges } from '../../../shared/charges.js';
import { r2, istParts, isDerivative, isOption } from '../../../shared/util.js';

const reject = (msg, code = 'RMS_REJECT') => bad(msg, code);
const onTick = (p, tick) => Math.abs(Math.round(p / tick) * tick - p) < 1e-6;

// Validates an order and returns the amount of funds to block. Throws on rejection.
export async function preTrade(h, user, o) {
  if (getSetting('kill_switch')) throw reject('Trading is temporarily halted by the broker', 'KILL_SWITCH');
  if (user.status !== 'active') throw forbidden('Your account is not active for trading yet');
  const acc = await h.one('select * from accounts where user_id=$1', [user.id]);
  if (acc.trading_blocked) throw reject('Trading is blocked on your account. Contact support.');
  const inst = getInstrument(o.token);
  if (!inst || !inst.active) throw reject('Instrument not available for trading');
  if (inst.segment === 'IDX') throw reject('Indices cannot be traded directly. Use index derivatives.');
  const deriv = inst.segment === 'FO';
  if (deriv) {
    if (!getSetting('fno_enabled')) throw reject('F&O trading is disabled');
    const k = await h.one('select segments from kyc where user_id=$1', [user.id]);
    if (!k?.segments?.includes('FO')) throw reject('F&O segment is not activated. Submit income proof to enable it.');
    if (inst.expiry < istParts().date) throw reject('Contract has expired');
    if (o.product === 'CNC') throw reject('Use NRML or MIS product for F&O');
  } else if (o.product === 'NRML') throw reject('NRML is only for F&O. Use CNC (delivery) or MIS (intraday).');

  const status = marketStatus();
  if (status !== 'OPEN') {
    if (o.variety !== 'AMO') throw reject('Market is closed. Place an After Market Order (AMO).', 'MARKET_CLOSED');
    if (!getSetting('allow_amo')) throw reject('AMO is not allowed right now');
  } else if (o.variety === 'AMO') o.variety = 'REGULAR'; // market opened meanwhile: treat as a regular order
  if (o.product === 'MIS' && status === 'OPEN' && getSetting('market_mode') === 'auto' && istParts().hm >= getSetting('square_off_time')) throw reject('Intraday (MIS) orders are not allowed after square-off time');

  if (o.qty % inst.lot !== 0) throw reject(`Quantity must be in multiples of lot size ${inst.lot}`);
  if (o.qty > inst.freeze_qty) throw reject(`Quantity exceeds freeze limit of ${inst.freeze_qty}. Split the order.`);

  const q = quote(o.token);
  if (!q) throw reject('No market price available');
  const tick = Number(inst.tick) || 0.05;
  for (const [k, v] of [['price', o.price], ['trigger', o.trigger_price]]) if (v != null && !onTick(v, tick)) throw reject(`${k === 'price' ? 'Price' : 'Trigger price'} must be a multiple of tick size ${tick}`);
  if (['LIMIT', 'SL'].includes(o.order_type) && !(o.price > 0)) throw reject('Enter a valid limit price');
  if (['SL', 'SL-M'].includes(o.order_type)) {
    if (!(o.trigger_price > 0)) throw reject('Enter a trigger price');
    if (o.side === 'BUY' && o.trigger_price <= q.ltp) throw reject('Trigger price for a stop-loss BUY order must be above the last traded price');
    if (o.side === 'SELL' && o.trigger_price >= q.ltp) throw reject('Trigger price for a stop-loss SELL order must be below the last traded price');
    if (o.order_type === 'SL' && ((o.side === 'BUY' && o.price < o.trigger_price) || (o.side === 'SELL' && o.price > o.trigger_price))) throw reject('Limit price must be beyond the trigger price for SL orders');
  }
  if (q.upper && o.price && (o.price > q.upper || o.price < q.lower)) throw reject(`Price must be within circuit limits ${q.lower} – ${q.upper}`);

  const px = o.order_type === 'MARKET' ? q.ltp : o.order_type === 'SL-M' ? o.trigger_price : o.price;
  if (o.qty * px > acc.max_order_value) throw reject(`Order value exceeds your per-order limit of ₹${acc.max_order_value.toLocaleString('en-IN')}`);

  const positions = await h.query('select token, product, qty, avg from positions where user_id=$1 and qty <> 0', [user.id]);
  const existing = positions.find((p) => p.token === o.token && p.product === o.product);
  const dir = o.side === 'BUY' ? 1 : -1;
  const opening = !existing || Math.sign(existing.qty) === dir || Math.abs(existing.qty) < o.qty;

  if (deriv && opening) {
    if (acc.fno_paused) throw reject('F&O trading is paused on your account (Settings → F&O SafeGuard)');
    if (acc.fno_day_loss >= acc.fno_loss_limit) throw reject(`F&O SafeGuard: today's loss ₹${acc.fno_day_loss} reached your daily limit`);
  }

  if (o.product === 'CNC' && o.side === 'SELL') {
    const hd = await h.one('select qty, t1_qty from holdings where user_id=$1 and token=$2', [user.id, o.token]);
    const pending = (await h.one(`select coalesce(sum(qty - filled_qty),0)::int n from orders where user_id=$1 and token=$2 and side='SELL' and product='CNC' and status in ('OPEN','TRIGGER_PENDING','OPEN_PENDING','AMO_REQ_RECEIVED','PUT_ORDER_REQ_RECEIVED')`, [user.id, o.token])).n;
    const free = (hd ? hd.qty + hd.t1_qty : 0) - pending;
    if (free < o.qty) throw reject(`You can sell at most ${Math.max(0, free)} shares from holdings (short selling in delivery is not allowed)`);
  }

  // Funds required = incremental margin (+ premium for option buys / full value for delivery buys) + charges
  const charges = calcCharges({ side: o.side, product: o.product, qty: o.qty, price: px, token: o.token }).total;
  let need;
  if (o.product === 'CNC') need = o.side === 'BUY' ? o.qty * px : 0;
  else {
    const after = positions.map((p) => ({ ...p }));
    const e = after.find((p) => p.token === o.token && p.product === o.product);
    if (e) { const nq = e.qty + dir * o.qty; if (Math.sign(nq) !== Math.sign(e.qty)) e.avg = px; e.qty = nq; } else after.push({ token: o.token, product: o.product, qty: dir * o.qty, avg: px });
    need = Math.max(0, positionsMargin(null, after) - positionsMargin(positions));
    if (isOption(o.token) && o.side === 'BUY') need += o.qty * px; // premium payable
  }
  need = r2(need + charges);
  const m = await margins(user.id, h);
  if (need > m.available + 0.005) throw reject(`Insufficient funds. Required ₹${need.toLocaleString('en-IN')}, available ₹${m.available.toLocaleString('en-IN')}`, 'INSUFFICIENT_FUNDS');
  return need;
}

// Post-trade: MTM-loss based square-off + scheduled intraday square-off. Returns users to square off.
export async function scanRisk() {
  const out = [];
  const pct = getSetting('mtm_square_off_pct');
  const users = await db.query(`select distinct user_id from positions where qty <> 0 and product in ('MIS','NRML')`);
  for (const { user_id } of users) {
    const m = await margins(user_id);
    if (m.usedMargin > 0 && m.mtm < 0 && -m.mtm >= (m.usedMargin * pct) / 100) out.push({ userId: user_id, reason: `MTM loss ₹${-m.mtm} reached ${pct}% of margin` });
    else if (m.cash + m.mtm < 0) out.push({ userId: user_id, reason: 'Account balance negative after MTM' });
  }
  return out;
}
export { isDerivative };
