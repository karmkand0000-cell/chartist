import { orderWindow, rerender } from '../app.js';
import { get, post, live } from '../api.js';
import { esc, num, inr, signed, pct, cls, tabs, empty, donut, toast, confirmBox } from '../ui.js';

let tab = 'holdings', unsub = null, pos = [];
export default {
  title: 'Portfolio', auth: true, active: true,
  async render() {
    const [holdings, positions] = await Promise.all([get('/api/holdings'), get('/api/positions')]);
    pos = positions;
    unsub?.(); unsub = live.sub([...holdings.map((h) => h.token), ...positions.map((p) => p.token)]);
    let body;
    if (tab === 'holdings') {
      const inv = holdings.reduce((a, h) => a + h.invested, 0), cur = holdings.reduce((a, h) => a + h.current, 0), day = holdings.reduce((a, h) => a + h.dayPnl, 0);
      const sec = {}; for (const h of holdings) sec[h.sector || 'Others'] = (sec[h.sector || 'Others'] || 0) + h.current;
      body = holdings.length ? `<div class="stats"><div class="card stat"><small>Invested</small><b>${inr(inv)}</b></div><div class="card stat"><small>Current</small><b>${inr(cur)}</b></div><div class="card stat"><small>Total P&amp;L</small><b class="${cls(cur - inv)}">${signed(cur - inv)} <small>${pct(inv ? (cur / inv - 1) * 100 : 0)}</small></b></div><div class="card stat"><small>Day's P&amp;L</small><b class="${cls(day)}">${signed(day)}</b></div></div>
        <div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Instrument</th><th class="r">Qty</th><th class="r">T1</th><th class="r">Avg cost</th><th class="r">LTP</th><th class="r">Current</th><th class="r">P&amp;L</th><th class="r">Day</th><th></th></tr></thead><tbody>
        ${holdings.map((h) => `<tr><td><a href="#/stock/${encodeURIComponent(h.token)}"><b>${esc(h.symbol)}</b></a></td><td class="r">${h.qty}</td><td class="r">${h.t1_qty || ''}</td><td class="r">${num(h.avg)}</td><td class="r" data-ltp="${esc(h.token)}">${num(h.ltp)}</td><td class="r">${inr(h.current)}</td><td class="r ${cls(h.pnl)}">${signed(h.pnl)}</td><td class="r ${cls(h.dayPct)}" data-chg="${esc(h.token)}">${pct(h.dayPct)}</td><td class="r nowrap"><button class="btn xs buy" data-b="${esc(h.token)}">Add</button> <button class="btn xs sell" data-x="${esc(h.token)}" data-q="${h.total}">Exit</button></td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">T1 = shares bought in the last session; they are credited to your demat after settlement and can still be sold (BTST).</p><h4>Allocation</h4>${donut(Object.entries(sec).map(([label, value]) => ({ label, value })))}` : empty('No holdings yet. Delivery (CNC) buys appear here.', '<a class="btn sm" href="#/markets">Explore stocks</a>');
    } else {
      const total = positions.reduce((a, p) => a + p.pnl, 0);
      body = positions.length ? `<div class="row between pad"><span>Total P&amp;L <b id="pt" class="${cls(total)}">${signed(total)}</b></span><button class="btn sm danger" id="exitAll">Exit all</button></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>Instrument</th><th class="r">Qty</th><th class="r">Avg</th><th class="r">LTP</th><th class="r">P&amp;L</th><th></th></tr></thead><tbody>
        ${positions.map((p, i) => `<tr class="${p.qty ? '' : 'closed'}"><td>${p.product}</td><td><a href="#/stock/${encodeURIComponent(p.token)}"><b>${esc(p.name)}</b></a></td><td class="r ${cls(p.qty)}">${p.qty}</td><td class="r">${p.qty ? num(p.avg) : '—'}</td><td class="r" data-ltp="${esc(p.token)}">${num(p.ltp)}</td><td class="r ${cls(p.pnl)}" data-pnl="${i}">${signed(p.pnl)}</td><td class="r">${p.qty ? `<button class="btn xs ghost" data-exit="${i}">Exit</button>` : '<small class="muted">Closed</small>'}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">MIS positions are auto squared-off at the cut-off time. RMS squares off positions if MTM loss breaches the configured limit.</p>` : empty('No positions today.');
    }
    return `<section class="page"><div class="page-head"><h1>Portfolio</h1></div><div class="card">${tabs('pf', [['holdings', `Holdings (${holdings.length})`], ['positions', `Positions (${positions.filter((p) => p.qty).length})`]], tab)}<div id="pb">${body}</div></div></section>`;
  },
  mount(root) {
    root.querySelector('[data-tabs="pf"]').onclick = (e) => { if (e.target.dataset.tab) { tab = e.target.dataset.tab; rerender(); } };
    root.querySelector('#pb').onclick = async (e) => {
      const d = e.target.dataset;
      if (d.b) orderWindow(d.b, 'BUY');
      if (d.x) orderWindow(d.x, 'SELL', { qty: d.q });
      if (d.exit) { const p = pos[+d.exit]; orderWindow(p.token, p.qty > 0 ? 'SELL' : 'BUY', { qty: Math.abs(p.qty), product: p.product }); }
      if (e.target.id === 'exitAll' && (await confirmBox('Exit all open positions at market price?'))) {
        for (const p of pos.filter((x) => x.qty)) await post('/api/positions/exit', { token: p.token, product: p.product }).catch((x) => toast(x.message, 'error'));
        toast('Exit orders placed', 'success'); setTimeout(rerender, 300);
      }
    };
  },
  onTick() {
    if (tab !== 'positions') return;
    let total = 0;
    pos.forEach((p, i) => {
      const ltp = live.quotes.get(p.token)?.ltp ?? p.ltp;
      const pnl = p.realised + (p.qty ? (ltp - p.avg) * p.qty : 0); total += pnl;
      const el = document.querySelector(`[data-pnl="${i}"]`); if (el) { el.textContent = signed(pnl); el.className = `r ${cls(pnl)}`; }
    });
    const t = document.getElementById('pt'); if (t) { t.textContent = signed(total); t.className = cls(total); }
  },
  onOrder() { rerender(); },
  unmount() { unsub?.(); unsub = null; },
};
