import { App } from '../app.js';
import { get, live } from '../api.js';
import { esc, num, pct, cls, inr, signed, empty, LOGO } from '../ui.js';
import { CONFIG } from '../config.js';

let unsub = null;
const mv = (q) => `<a class="mv" href="#/stock/${encodeURIComponent(q.token)}"><span><b>${esc(q.symbol)}</b><small>${esc(q.name)}</small></span><span class="r"><b data-ltp="${esc(q.token)}">${num(q.ltp)}</b><em class="${cls(q.change)}" data-chg="${esc(q.token)}">${pct(q.pct)}</em></span></a>`;
const idx = (list) => `<div class="idx-cards">${list.map((q) => `<a class="card idx" href="#/stock/${encodeURIComponent(q.token)}"><small>${esc(q.name)}</small><b data-ltp="${esc(q.token)}">${num(q.ltp)}</b><em class="${cls(q.change)}" data-chg="${esc(q.token)}" data-mode="abs">${q.change >= 0 ? '+' : ''}${num(q.change)} (${pct(q.pct)})</em></a>`).join('')}</div>`;

export default {
  title: 'Dashboard',
  async render() {
    const ov = await get('/api/market/overview');
    unsub?.(); unsub = live.sub([...ov.gainers, ...ov.losers].map((q) => q.token));
    if (!App.user) {
      return `<section class="hero"><div class="hero-txt"><span class="pill">Stocks · F&amp;O · Zero-commission delivery</span><h1>Invest and trade with ${esc(CONFIG.brand)}</h1>
        <p>Open a free Demat &amp; trading account online. Pro charts, option chain, GTT orders, two-factor security and transparent charges.</p>
        <div class="row"><a class="btn lg" href="#/signup">Open free account</a><a class="btn ghost lg" href="#/login">Log in</a></div></div>
        <div class="hero-card card"><div class="hc-head">${LOGO}<b>Markets today</b></div>${idx(ov.indices.slice(0, 4))}<h4>Top gainers</h4>${ov.gainers.slice(0, 4).map(mv).join('')}</div></section>`;
    }
    if (App.user.status !== 'active') {
      return `<section class="page"><div class="banner"><span>Your account is not active yet. Complete account opening to start trading.</span><a class="btn sm" href="#/onboarding">Continue account opening</a></div>${idx(ov.indices)}<div class="grid2"><div class="card"><h3>Top gainers</h3>${ov.gainers.slice(0, 6).map(mv).join('')}</div><div class="card"><h3>Top losers</h3>${ov.losers.slice(0, 6).map(mv).join('')}</div></div></section>`;
    }
    const [f, holdings, positions, orders] = await Promise.all([App.refreshFunds(), get('/api/holdings'), get('/api/positions'), get('/api/orders')]);
    const inv = holdings.reduce((a, h) => a + h.invested, 0), cur = holdings.reduce((a, h) => a + h.current, 0), day = holdings.reduce((a, h) => a + h.dayPnl, 0);
    const posPnl = positions.reduce((a, p) => a + p.pnl, 0);
    const open = orders.filter((o) => ['OPEN', 'TRIGGER_PENDING', 'AMO_REQ_RECEIVED'].includes(o.status));
    return `<section class="page"><div class="page-head"><h1>Hi, ${esc(App.user.name.split(' ')[0])}</h1><div class="row"><a class="btn ghost sm" href="#/funds">Add funds</a><a class="btn sm" href="#/markets">Markets</a></div></div>
      ${idx(ov.indices)}
      <div class="stats">
        <div class="card stat"><small>Available margin</small><b>${inr(f?.available)}</b><em>Used ${inr(f?.usedMargin)} · Cash ${inr(f?.cash)}</em></div>
        <div class="card stat"><small>Holdings value</small><b>${inr(cur)}</b><em>Invested ${inr(inv)}</em></div>
        <div class="card stat"><small>Holdings P&amp;L</small><b class="${cls(cur - inv)}">${signed(cur - inv)}</b><em class="${cls(day)}">Today ${signed(day)}</em></div>
        <div class="card stat"><small>Positions P&amp;L</small><b class="${cls(posPnl)}">${signed(posPnl)}</b><em>${positions.filter((p) => p.qty).length} open · ${open.length} pending orders</em></div>
      </div>
      <div class="grid2"><div class="card"><div class="card-head"><h3>Holdings</h3><a href="#/portfolio">View all</a></div>
        ${holdings.length ? `<table class="tbl"><thead><tr><th>Stock</th><th class="r">Qty</th><th class="r">LTP</th><th class="r">P&amp;L</th></tr></thead><tbody>${holdings.slice(0, 6).map((h) => `<tr><td><a href="#/stock/${encodeURIComponent(h.token)}">${esc(h.symbol)}</a></td><td class="r">${h.total}</td><td class="r" data-ltp="${esc(h.token)}">${num(h.ltp)}</td><td class="r ${cls(h.pnl)}">${signed(h.pnl)}</td></tr>`).join('')}</tbody></table>` : empty('No holdings yet.', '<a class="btn sm" href="#/markets">Explore stocks</a>')}</div>
        <div class="card"><div class="card-head"><h3>Market movers</h3></div><div class="tabs"><button class="tab active" data-mv="gainers">Gainers</button><button class="tab" data-mv="losers">Losers</button><button class="tab" data-mv="active">Most active</button></div><div id="mvList">${ov.gainers.slice(0, 6).map(mv).join('')}</div></div></div></section>`;
  },
  async mount(root) {
    const ov = await get('/api/market/overview');
    root.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = () => { root.querySelectorAll('[data-mv]').forEach((x) => x.classList.toggle('active', x === b)); root.querySelector('#mvList').innerHTML = ov[b.dataset.mv].slice(0, 6).map(mv).join(''); }));
  },
  unmount() { unsub?.(); unsub = null; },
};
