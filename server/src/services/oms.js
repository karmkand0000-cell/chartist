// Order Management System: order lifecycle, exchange events, trades, GTT, alerts, square-offs
import { EventEmitter } from 'node:events';
import { db } from '../db.js';
import { config } from '../config.js';
import { bad, notFound, forbidden } from '../errors.js';
import { audit, notify } from './audit.js';
import { preTrade, scanRisk } from './rms.js';
import { applyTrade } from './portfolio.js';
import { getSetting } from './settings.js';
import { getInstrument } from './instruments.js';
import { quote, bus as marketBus, marketStatus, isOpen } from './market.js';
import { ExchangeSimulator } from '../exchange/simulator.js';
import { calcCharges } from '../../../shared/charges.js';
import { r2, istParts, displayName } from '../../../shared/util.js';

export const events = new EventEmitter(); // 'order' | 'trade' | 'notify'  → WebSocket
events.setMaxListeners(0);
let exchange = null;
const LIVE = ['PUT_ORDER_REQ_RECEIVED', 'OPEN_PENDING', 'OPEN', 'TRIGGER_PENDING', 'AMO_REQ_RECEIVED'];

export async function initOms() {
  if (config.exchangeAdapter === 'nse') {
    const { NseGateway } = await import('../exchange/nse-gateway.js');
    exchange = new NseGateway();
  } else exchange = new ExchangeSimulator();
  let chain = Promise.resolve();
  exchange.on('event', (ev) => { chain = chain.then(() => onExchangeEvent(ev)).catch((e) => console.error('exchange event', e)); });
  // Re-send orders that were live at the exchange before a restart (simulator book is in memory)
  for (const o of await db.query(`select * from orders where status in ('OPEN','TRIGGER_PENDING','OPEN_PENDING')`)) exchange.submit(o);
  marketBus.on('ticks', onTicks);
}
export const exchangeName = () => exchange?.name || 'NONE';

function normalise(input) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return {
    token: String(input.token || ''), side: String(input.side || '').toUpperCase(), qty: Math.floor(Number(input.qty)),
    order_type: String(input.order_type || input.type || 'MARKET').toUpperCase(), product: String(input.product || 'CNC').toUpperCase(),
    validity: String(input.validity || 'DAY').toUpperCase(), variety: String(input.variety || 'REGULAR').toUpperCase(),
    price: n(input.price), trigger_price: n(input.trigger_price ?? input.trigger), tag: input.tag ? String(input.tag).slice(0, 20) : null,
    client_order_id: input.client_order_id ? String(input.client_order_id).slice(0, 40) : null,
  };
}

async function event(h, orderId, status, message) {
  await h.query('insert into order_events(order_id, status, message) values ($1,$2,$3)', [orderId, status, message || null]);
}
async function push(orderId) {
  const o = await db.one('select * from orders where id=$1', [orderId]);
  if (o) events.emit('order', { userId: o.user_id, order: decorate(o) });
  return o;
}
export const decorate = (o) => ({ ...o, name: displayName(o.token), pending_qty: o.qty - o.filled_qty });

export async function placeOrder(user, input, { placedBy, ip } = {}) {
  const o = normalise(input);
  if (!['BUY', 'SELL'].includes(o.side)) throw bad('Side must be BUY or SELL');
  if (!(o.qty > 0)) throw bad('Quantity must be a positive whole number');
  if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(o.order_type)) throw bad('Invalid order type');
  if (!['CNC', 'MIS', 'NRML'].includes(o.product)) throw bad('Invalid product');
  if (!['DAY', 'IOC'].includes(o.validity)) throw bad('Invalid validity');
  if (o.order_type === 'MARKET' || o.order_type === 'SL-M') o.price = null;
  if (o.order_type === 'MARKET' || o.order_type === 'LIMIT') o.trigger_price = null;
  if (o.client_order_id) {
    const dup = await db.one('select * from orders where user_id=$1 and client_order_id=$2', [user.id, o.client_order_id]);
    if (dup) return decorate(dup); // idempotent retry
  }
  const today = istParts().date;
  let order;
  try {
    order = await db.tx(async (t) => {
      await t.query('select user_id from accounts where user_id=$1 for update', [user.id]);
      const blocked = await preTrade(t, user, o);
      const status = o.variety === 'AMO' ? 'AMO_REQ_RECEIVED' : 'OPEN_PENDING';
      const row = await t.one(`insert into orders(user_id, client_order_id, token, side, qty, price, trigger_price, order_type, product, validity, variety, status, tag, blocked, placed_by, trade_date)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [user.id, o.client_order_id, o.token, o.side, o.qty, o.price, o.trigger_price, o.order_type, o.product, o.validity, o.variety, status, o.tag, blocked, placedBy || user.id, today]);
      await event(t, row.id, status, o.variety === 'AMO' ? 'AMO received; will be sent at market open' : 'Validated by RMS');
      return row;
    });
  } catch (e) {
    if (e.code && e.status === 400 && !/Quantity must be|Side must|Invalid/.test(e.message)) {
      // Persist RMS rejections in the order book like real brokers do
      const inst = getInstrument(o.token);
      if (inst) {
        const row = await db.one(`insert into orders(user_id, client_order_id, token, side, qty, price, trigger_price, order_type, product, validity, variety, status, status_message, tag, placed_by, trade_date)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'REJECTED',$12,$13,$14,$15) returning *`,
        [user.id, o.client_order_id, o.token, o.side, o.qty, o.price, o.trigger_price, o.order_type, o.product, o.validity, o.variety, e.message, o.tag, placedBy || user.id, today]).catch(() => null);
        if (row) { await event(db, row.id, 'REJECTED', e.message); events.emit('order', { userId: user.id, order: decorate(row) }); e.extra = { ...(e.extra || {}), order: decorate(row) }; }
      }
    }
    throw e;
  }
  await audit({ id: placedBy || user.id, role: placedBy && placedBy !== user.id ? 'rms' : user.role }, 'order_placed', 'order', order.id, { token: o.token, side: o.side, qty: o.qty, type: o.order_type }, ip);
  if (order.status === 'OPEN_PENDING') exchange.submit(order);
  await push(order.id);
  return decorate(order);
}

export async function modifyOrder(user, id, input, ip) {
  const o = await db.one('select * from orders where id=$1 and user_id=$2', [id, user.id]);
  if (!o) throw notFound('Order not found');
  if (!['OPEN', 'TRIGGER_PENDING', 'AMO_REQ_RECEIVED'].includes(o.status)) throw bad(`Order is ${o.status} and cannot be modified`);
  const n = (v) => (v === '' || v == null ? undefined : Number(v));
  const next = { ...o, qty: n(input.qty) ?? o.qty, price: n(input.price) ?? o.price, trigger_price: n(input.trigger_price) ?? o.trigger_price, order_type: input.order_type || o.order_type };
  if (next.qty <= o.filled_qty) throw bad('Quantity must be more than the filled quantity');
  // Re-run RMS for the remaining quantity with the old block released
  await db.tx(async (t) => {
    await t.query('update orders set blocked=0 where id=$1', [id]);
    const blocked = await preTrade(t, user, { ...next, qty: next.qty - o.filled_qty, variety: o.variety, side: o.side, product: o.product, token: o.token });
    await t.query('update orders set qty=$2, price=$3, trigger_price=$4, order_type=$5, blocked=$6, updated_at=now() where id=$1', [id, next.qty, next.price, next.trigger_price, next.order_type, blocked]);
    await event(t, id, 'MODIFY_REQUESTED', `qty ${next.qty} price ${next.price ?? 'MKT'} trigger ${next.trigger_price ?? '-'}`);
  });
  if (o.exchange_order_id) exchange.modify(o.exchange_order_id, { qty: next.qty, price: next.price, trigger_price: next.trigger_price, order_type: next.order_type });
  await audit(user, 'order_modified', 'order', id, input, ip);
  return decorate(await push(id));
}

export async function cancelOrder(user, id, ip, reason = 'Cancelled by user') {
  const o = await db.one('select * from orders where id=$1 and user_id=$2', [id, user.id]);
  if (!o) throw notFound('Order not found');
  if (!LIVE.includes(o.status)) throw bad(`Order is ${o.status} and cannot be cancelled`);
  if (o.exchange_order_id && exchange.cancel(o.exchange_order_id, reason)) {
    await audit(user, 'order_cancel_requested', 'order', id, null, ip);
    return decorate(o);
  }
  await db.query(`update orders set status='CANCELLED', status_message=$2, blocked=0, updated_at=now() where id=$1`, [id, reason]);
  await event(db, id, 'CANCELLED', reason);
  await audit(user, 'order_cancelled', 'order', id, null, ip);
  return decorate(await push(id));
}

async function onExchangeEvent(ev) {
  const o = ev.orderId ? await db.one('select * from orders where id=$1', [ev.orderId]) : await db.one('select * from orders where exchange_order_id=$1', [ev.exchangeOrderId]);
  if (!o) return;
  if (ev.type === 'ack') {
    await db.query('update orders set status=$2, exchange_order_id=$3, updated_at=now() where id=$1 and status in ($4,$5)', [o.id, ev.status, ev.exchangeOrderId, 'OPEN_PENDING', 'AMO_REQ_RECEIVED']);
    await event(db, o.id, ev.status, `Accepted by exchange (${ev.exchangeOrderId})`);
  } else if (ev.type === 'triggered') {
    await db.query(`update orders set status='OPEN', updated_at=now() where id=$1 and status='TRIGGER_PENDING'`, [o.id]);
    await event(db, o.id, 'OPEN', 'Stop-loss triggered');
  } else if (ev.type === 'trade') {
    await db.tx(async (t) => {
      const cur = await t.one('select * from orders where id=$1 for update', [o.id]);
      const filled = cur.filled_qty + ev.qty;
      const avg = r2(((cur.avg_price || 0) * cur.filled_qty + ev.price * ev.qty) / filled);
      const status = filled >= cur.qty ? 'COMPLETE' : 'OPEN';
      const releaseFrac = ev.qty / (cur.qty - cur.filled_qty);
      const blocked = status === 'COMPLETE' ? 0 : r2(cur.blocked * (1 - releaseFrac));
      const charges = calcCharges({ side: cur.side, product: cur.product, qty: ev.qty, price: ev.price, token: cur.token });
      const tr = await t.one(`insert into trades(order_id, user_id, token, side, qty, price, product, exchange_trade_id, trade_date, charges)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`, [cur.id, cur.user_id, cur.token, cur.side, ev.qty, ev.price, cur.product, ev.tradeId, istParts().date, JSON.stringify(charges)]);
      const pnl = await applyTrade(t, tr);
      if (pnl) await t.query('update trades set pnl=$2 where id=$1', [tr.id, pnl]);
      await t.query('update orders set filled_qty=$2, avg_price=$3, status=$4, blocked=$5, updated_at=now() where id=$1', [cur.id, filled, avg, status, blocked]);
      await event(t, cur.id, status, `Traded ${ev.qty} @ ${ev.price}`);
      events.emit('trade', { userId: cur.user_id, trade: { ...tr, pnl, name: displayName(cur.token) } });
    });
  } else if (ev.type === 'cancelled' || ev.type === 'reject') {
    const st = ev.type === 'reject' ? 'REJECTED' : 'CANCELLED';
    await db.query('update orders set status=$2, status_message=$3, blocked=0, updated_at=now() where id=$1 and status not in ($4,$5,$6)', [o.id, st, ev.message, 'COMPLETE', 'CANCELLED', 'REJECTED']);
    await event(db, o.id, st, ev.message);
  } else if (ev.type === 'modify_reject') {
    await event(db, o.id, o.status, `Modification rejected: ${ev.message}`);
  } else if (ev.type === 'modified') {
    await event(db, o.id, o.status, 'Modified at exchange');
  }
  await push(o.id);
}

// ── Market open: release AMOs. Square-off time: close MIS. Ticks: GTT + alerts.
let lastStatus = null, sqDay = '', scanning = false;
async function onTicks() {
  const st = marketStatus();
  if (st === 'OPEN' && lastStatus && lastStatus !== 'OPEN') await releaseAmo().catch((e) => console.error(e));
  lastStatus = st;
  if (scanning) return;
  scanning = true;
  try {
    await checkGtts();
    await checkAlerts();
    const { date, hm } = istParts();
    if (st === 'OPEN' && getSetting('market_mode') === 'auto' && hm >= getSetting('square_off_time') && sqDay !== date) { sqDay = date; await squareOffAll('MIS', 'Auto square-off (intraday cut-off)'); }
  } catch (e) { console.error('tick handler', e); } finally { scanning = false; }
}

export async function releaseAmo() {
  const list = await db.query(`select * from orders where status='AMO_REQ_RECEIVED'`);
  for (const o of list) {
    await db.query(`update orders set status='OPEN_PENDING', trade_date=$2 where id=$1`, [o.id, istParts().date]);
    exchange.submit({ ...o, status: 'OPEN_PENDING' });
  }
  return list.length;
}

export async function squareOffUser(userId, products = ['MIS', 'NRML'], reason = 'RMS square-off', actor) {
  const user = await db.one('select * from users where id=$1', [userId]);
  for (const o of await db.query(`select id from orders where user_id=$1 and status in ('OPEN','TRIGGER_PENDING') and product = any($2)`, [userId, products])) await cancelOrder(user, o.id, null, reason).catch(() => {});
  const res = [];
  for (const p of await db.query('select * from positions where user_id=$1 and qty <> 0 and product = any($2)', [userId, products])) {
    try { res.push(await placeSystemOrder(user, { token: p.token, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty), product: p.product, order_type: 'MARKET', tag: 'SQOFF' }, actor)); } catch (e) { res.push({ error: e.message, token: p.token }); }
  }
  await db.query('insert into risk_events(user_id, kind, message) values ($1,$2,$3)', [userId, 'SQUARE_OFF', reason]);
  await notify(userId, 'Positions squared off', reason);
  events.emit('notify', { userId, title: 'Positions squared off', body: reason });
  return res;
}
async function squareOffAll(product, reason) {
  const users = await db.query('select distinct user_id from positions where qty <> 0 and product=$1', [product]);
  for (const u of users) await squareOffUser(u.user_id, [product], reason);
}
// System orders bypass the funds check for risk-reducing exits but still go through the exchange
async function placeSystemOrder(user, input, actor) {
  const today = istParts().date;
  const row = await db.one(`insert into orders(user_id, token, side, qty, order_type, product, status, tag, placed_by, trade_date) values ($1,$2,$3,$4,'MARKET',$5,'OPEN_PENDING',$6,$7,$8) returning *`,
    [user.id, input.token, input.side, input.qty, input.product, input.tag, actor?.id || null, today]);
  await event(db, row.id, 'OPEN_PENDING', 'System order');
  if (isOpen() || config.dev) exchange.submit(row);
  return decorate(row);
}

let riskTimer = null;
export function startRiskMonitor(ms = 5000) {
  clearInterval(riskTimer);
  riskTimer = setInterval(async () => {
    if (!isOpen()) return;
    try { for (const r of await scanRisk()) await squareOffUser(r.userId, ['MIS', 'NRML'], r.reason); } catch (e) { console.error('risk monitor', e); }
  }, ms);
  riskTimer.unref?.();
}

// ── GTT
export async function createGtt(user, input) {
  const inst = getInstrument(input.token);
  if (!inst || inst.segment !== 'EQ') throw bad('GTT is available for equity delivery only');
  const q = quote(input.token);
  const kind = input.kind === 'OCO' ? 'OCO' : 'SINGLE';
  const qty = Math.floor(Number(input.qty));
  if (!(qty > 0)) throw bad('Enter quantity');
  const n = (v) => (v === '' || v == null ? null : Number(v));
  if (kind === 'OCO') {
    const target = n(input.target), stoploss = n(input.stoploss);
    if (!(stoploss < q.ltp && target > q.ltp)) throw bad('OCO needs stop-loss below and target above the current price');
    const hd = await db.one('select qty + t1_qty as q from holdings where user_id=$1 and token=$2', [user.id, input.token]);
    if (!hd || hd.q < qty) throw bad('OCO sell GTT needs the shares in your holdings');
    return db.one(`insert into gtts(user_id, token, kind, side, qty, target, stoploss, ref_price, expires_at) values ($1,$2,'OCO','SELL',$3,$4,$5,$6, now() + interval '365 days') returning *`, [user.id, input.token, qty, target, stoploss, q.ltp]);
  }
  const side = input.side === 'SELL' ? 'SELL' : 'BUY';
  const trig = n(input.trigger_price), lim = n(input.limit_price) ?? trig;
  if (!(trig > 0)) throw bad('Enter trigger price');
  if (Math.abs(trig - q.ltp) / q.ltp < 0.0025) throw bad('Trigger must be at least 0.25% away from the last price');
  return db.one(`insert into gtts(user_id, token, kind, side, qty, trigger_price, limit_price, ref_price, expires_at) values ($1,$2,'SINGLE',$3,$4,$5,$6,$7, now() + interval '365 days') returning *`, [user.id, input.token, side, qty, trig, lim, q.ltp]);
}
async function checkGtts() {
  if (!isOpen()) return;
  for (const g of await db.query(`select * from gtts where status='ACTIVE' and expires_at > now()`)) {
    const q = quote(g.token); if (!q) continue;
    let fire = null;
    if (g.kind === 'OCO') { if (q.ltp >= g.target) fire = { leg: 'target', price: g.target }; else if (q.ltp <= g.stoploss) fire = { leg: 'stoploss', price: Math.min(g.stoploss, q.ltp) }; }
    else { const up = g.trigger_price >= g.ref_price; if ((up && q.ltp >= g.trigger_price) || (!up && q.ltp <= g.trigger_price)) fire = { leg: 'trigger', price: g.limit_price }; }
    if (!fire) continue;
    const upd = await db.one(`update gtts set status='TRIGGERED', fired_leg=$2 where id=$1 and status='ACTIVE' returning *`, [g.id, fire.leg]);
    if (!upd) continue;
    const user = await db.one('select * from users where id=$1', [g.user_id]);
    try {
      const inst = getInstrument(g.token); const tick = Number(inst.tick) || 0.05;
      const o = await placeOrder(user, { token: g.token, side: g.side, qty: g.qty, product: 'CNC', order_type: 'LIMIT', price: Math.round(fire.price / tick) * tick, tag: 'GTT' });
      await db.query('update gtts set order_id=$2 where id=$1', [g.id, o.id]);
      await notify(g.user_id, 'GTT triggered', `${displayName(g.token)} ${g.side} ${g.qty} (${fire.leg})`);
    } catch (e) {
      await db.query(`update gtts set status='FAILED' where id=$1`, [g.id]);
      await notify(g.user_id, 'GTT order failed', e.message);
    }
    events.emit('notify', { userId: g.user_id, title: 'GTT triggered', body: `${displayName(g.token)} (${fire.leg})` });
  }
}
async function checkAlerts() {
  for (const a of await db.query(`select * from alerts where status='ACTIVE'`)) {
    const q = quote(a.token); if (!q) continue;
    if ((a.direction === 'above' && q.ltp >= a.price) || (a.direction === 'below' && q.ltp <= a.price)) {
      await db.query(`update alerts set status='TRIGGERED' where id=$1`, [a.id]);
      const body = `${displayName(a.token)} is ${a.direction} ${a.price} (LTP ${q.ltp})`;
      await notify(a.user_id, '🔔 Price alert', body);
      events.emit('notify', { userId: a.user_id, title: 'Price alert', body });
    }
  }
}

export function assertOwner(user, row) { if (!row || row.user_id !== user.id) throw forbidden(); }
export { exchange };
