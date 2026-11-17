import { orderWindow, rerender } from '../app.js';
import { get, del, live } from '../api.js';
import { esc, num, inr, signed, cls, tabs, empty, toast, modal, confirmBox, dt } from '../ui.js';

let tab = 'open', unsub = null;
const LIVE = ['OPEN', 'TRIGGER_PENDING', 'AMO_REQ_RECEIVED', 'OPEN_PENDING'];
const st = (s) => `<span class="st ${s}">${s.replace(/_/g, ' ')}</span>`;
const sd = (s) => `<span class="tag ${s === 'BUY' ? 'buy' : 'sell'}">${s}</span>`;

export default {
  title: 'Orders', auth: true, active: true,
  async render() {
    const [orders, gtts, trades] = await Promise.all([get('/api/orders'), get('/api/gtt'), get('/api/trades')]);
    const open = orders.filter((o) => LIVE.includes(o.status));
    unsub?.(); unsub = live.sub([...new Set(open.map((o) => o.token))]);
    let body = '';
    if (tab === 'open') body = open.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Type</th><th>Instrument</th><th>Product</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Trigger</th><th class="r">LTP</th><th>Status</th><th></th></tr></thead><tbody>${open.map((o) => `<tr><td class="muted">${dt(o.created_at)}</td><td>${sd(o.side)} ${o.order_type}</td><td><a href="#/stock/${encodeURIComponent(o.token)}">${esc(o.name)}</a>${o.variety === 'AMO' ? ' <small class="tag">AMO</small>' : ''}</td><td>${o.product}</td><td class="r">${o.filled_qty}/${o.qty}</td><td class="r">${o.price ? num(o.price) : 'MKT'}</td><td class="r">${o.trigger_price ? num(o.trigger_price) : '—'}</td><td class="r" data-ltp="${esc(o.token)}">—</td><td>${st(o.status)}</td><td class="r nowrap"><button class="btn xs ghost" data-mod="${o.id}">Modify</button> <button class="btn xs danger" data-cancel="${o.id}">Cancel</button></td></tr>`).join('')}</tbody></table></div>` : empty('No open orders.');
    if (tab === 'history') { const h = orders.filter((o) => !LIVE.includes(o.status)); body = h.length ? `<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Time</th><th>Type</th><th>Instrument</th><th>Product</th><th class="r">Qty</th><th class="r">Avg price</th><th>Status</th></tr></thead><tbody>${h.map((o) => `<tr data-view="${o.id}" style="cursor:pointer"><td class="muted">${dt(o.created_at)}</td><td>${sd(o.side)} ${o.order_type}${o.tag ? ` <small class="muted">${esc(o.tag)}</small>` : ''}</td><td>${esc(o.name)}</td><td>${o.product}</td><td class="r">${o.filled_qty}/${o.qty}</td><td class="r">${o.avg_price ? num(o.avg_price) : '—'}</td><td>${st(o.status)}${o.status_message ? `<small class="block ${o.status === 'REJECTED' ? 'down' : 'muted'}">${esc(o.status_message)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No orders in the last 7 days.'); }
    if (tab === 'trades') body = trades.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Trade ID</th><th>Instrument</th><th>Side</th><th>Product</th><th class="r">Qty</th><th class="r">Price</th><th class="r">P&amp;L</th><th class="r">Charges</th></tr></thead><tbody>${trades.map((t) => `<tr><td class="muted">${dt(t.created_at)}</td><td class="muted small">${esc(t.exchange_trade_id)}</td><td>${esc(t.name)}</td><td>${sd(t.side)}</td><td>${t.product}</td><td class="r">${t.qty}</td><td class="r">${num(t.price)}</td><td class="r ${cls(t.pnl)}">${t.pnl ? signed(t.pnl) : '—'}</td><td class="r">${num(t.charges.total)}</td></tr>`).join('')}</tbody></table></div>` : empty('No trades yet.');
    if (tab === 'gtt') body = gtts.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Created</th><th>Instrument</th><th>Type</th><th class="r">Qty</th><th class="r">Trigger</th><th>Status</th><th></th></tr></thead><tbody>${gtts.map((g) => `<tr><td class="muted">${dt(g.created_at)}</td><td>${esc(g.name)}</td><td>${sd(g.side)} ${g.kind}</td><td class="r">${g.qty}</td><td class="r">${g.kind === 'OCO' ? `SL ${num(g.stoploss)} · T ${num(g.target)}` : `${num(g.trigger_price)} → ${num(g.limit_price)}`}</td><td>${st(g.status)}${g.fired_leg ? ` <small>${g.fired_leg}</small>` : ''}</td><td class="r">${g.status === 'ACTIVE' ? `<button class="btn xs danger" data-gdel="${g.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No GTT orders. Create one from any stock page.');
    return `<section class="page"><div class="page-head"><h1>Orders</h1></div><div class="card">${tabs('o', [['open', `Open (${open.length})`], ['history', 'Order history'], ['trades', 'Trade book'], ['gtt', `GTT (${gtts.filter((g) => g.status === 'ACTIVE').length})`]], tab)}<div id="ob">${body}</div></div></section>`;
  },
  mount(root) {
    root.querySelector('[data-tabs="o"]').onclick = (e) => { if (e.target.dataset.tab) { tab = e.target.dataset.tab; rerender(); } };
    root.querySelector('#ob').onclick = async (e) => {
      const d = e.target.dataset;
      try {
        if (d.cancel && (await confirmBox('Cancel this order?'))) { await del(`/api/orders/${d.cancel}`); toast('Cancel request sent'); setTimeout(rerender, 150); }
        if (d.gdel) { await del(`/api/gtt/${d.gdel}`); toast('GTT deleted'); rerender(); }
        if (d.mod) { const o = await get(`/api/orders/${d.mod}`); orderWindow(o.token, o.side, { ...o, modifyId: o.id }); }
        const v = e.target.closest('[data-view]');
        if (v) { const o = await get(`/api/orders/${v.dataset.view}`); modal(`<h3>${esc(o.name)} · ${o.side} ${o.qty}</h3><p class="muted">Order #${o.id} · Exchange ID ${esc(o.exchange_order_id || '—')}</p><ul class="events">${o.events.map((x) => `<li><b>${x.status.replace(/_/g, ' ')}</b> · ${esc(x.message || '')} <small class="muted">${dt(x.created_at)}</small></li>`).join('')}</ul>${o.trades.length ? `<h4>Fills</h4><ul class="events">${o.trades.map((t) => `<li>${t.qty} @ ${num(t.price)} <small class="muted">${esc(t.exchange_trade_id)}</small></li>`).join('')}</ul>` : ''}`); }
      } catch (x) { toast(x.message, 'error'); }
    };
  },
  onOrder() { rerender(); },
  unmount() { unsub?.(); unsub = null; },
};
