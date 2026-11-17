import { orderWindow, addToWatchlist } from '../app.js';
import { get, live } from '../api.js';
import { esc, num, pct, cls, compact, tabs } from '../ui.js';

let view = 'all', sector = '', sortKey = 'pct', dir = -1, unsub = null, data = null;
function table() {
  let list = data.all.filter((q) => !sector || q.sector === sector);
  list = list.map((q) => ({ ...q, ...(live.quotes.get(q.token) || {}) })).sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1) * dir);
  const th = (k, l, r = true) => `<th class="${r ? 'r' : ''} sortable ${sortKey === k ? 'sorted' : ''}" data-sort="${k}">${l}</th>`;
  return `<div class="tbl-wrap"><table class="tbl hover"><thead><tr>${th('symbol', 'Company', false)}${th('ltp', 'LTP')}${th('pct', 'Change')}${th('volume', 'Volume')}<th class="r">Day range</th><th class="r">Trade</th></tr></thead><tbody>
  ${list.map((q) => `<tr><td><a href="#/stock/${encodeURIComponent(q.token)}"><b>${esc(q.symbol)}</b><small class="block muted">${esc(q.name)}</small></a></td><td class="r" data-ltp="${esc(q.token)}">${num(q.ltp)}</td><td class="r ${cls(q.change)}" data-chg="${esc(q.token)}">${pct(q.pct)}</td><td class="r">${compact(q.volume)}</td><td class="r muted">${num(q.low)} – ${num(q.high)}</td>
  <td class="r nowrap"><button class="btn xs buy" data-b="${esc(q.token)}">B</button> <button class="btn xs sell" data-s="${esc(q.token)}">S</button> <button class="btn xs ghost" data-w="${esc(q.token)}">+</button></td></tr>`).join('')}</tbody></table></div>`;
}
function heat() {
  const by = {};
  for (const q of data.all) (by[q.sector || 'Others'] ||= []).push({ ...q, ...(live.quotes.get(q.token) || {}) });
  return `<div class="heat">${Object.entries(by).map(([s, l]) => `<div class="heat-sec"><h4>${esc(s)}</h4><div class="heat-grid">${l.map((q) => { const a = Math.min(1, Math.abs(q.pct) / 3); return `<a href="#/stock/${encodeURIComponent(q.token)}" style="background:${q.pct >= 0 ? `rgba(18,184,134,${0.15 + a * 0.75})` : `rgba(240,62,62,${0.15 + a * 0.75})`}"><b>${esc(q.symbol)}</b><span>${pct(q.pct)}</span></a>`; }).join('')}</div></div>`).join('')}</div>`;
}
export default {
  title: 'Markets',
  async render() {
    data = await get('/api/market/overview');
    unsub?.(); unsub = live.sub(data.all.map((q) => q.token));
    const sectors = [...new Set(data.all.map((q) => q.sector).filter(Boolean))].sort();
    return `<section class="page"><div class="page-head"><h1>Markets</h1></div>
      <div class="card"><div class="card-head">${tabs('mk', [['all', 'Equity'], ['heat', 'Heatmap']], view)}<select id="sec"><option value="">All sectors</option>${sectors.map((s) => `<option ${s === sector ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <div id="body">${view === 'heat' ? heat() : table()}</div></div></section>`;
  },
  mount(root) {
    const body = root.querySelector('#body');
    const redraw = () => (body.innerHTML = view === 'heat' ? heat() : table());
    root.querySelector('[data-tabs="mk"]').onclick = (e) => { if (e.target.dataset.tab) { view = e.target.dataset.tab; root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === view)); redraw(); } };
    root.querySelector('#sec').onchange = (e) => { sector = e.target.value; redraw(); };
    body.onclick = (e) => {
      const d = e.target.dataset;
      if (d.sort) { dir = sortKey === d.sort ? -dir : -1; sortKey = d.sort; redraw(); }
      if (d.b) orderWindow(d.b, 'BUY'); if (d.s) orderWindow(d.s, 'SELL'); if (d.w) addToWatchlist(d.w);
    };
  },
  unmount() { unsub?.(); unsub = null; },
};
