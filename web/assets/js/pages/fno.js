import { App, orderWindow, rerender } from '../app.js';
import { get, post, live } from '../api.js';
import { esc, num, signed, cls, compact, toast } from '../ui.js';
import { payoffCurve, bs, smileIV, yearsTo } from '../../../shared/options.js';

let U = 'NIFTY', expiry = null, legs = [], greeks = false, ch = null, unsub = null;

function payoff() {
  if (!legs.length) return '<div class="payoff-empty">Tap <b>B</b> / <b>S</b> next to any strike or choose a strategy to see the payoff.</div>';
  const L = legs.map((l) => ({ type: l.type, strike: l.strike, qty: (l.side === 'BUY' ? 1 : -1) * l.lots * ch.lot, avg: l.premium }));
  const spot = ch.spot, ks = L.map((l) => l.strike);
  const width = Math.min(0.1, Math.max(0.02, ((Math.max(...ks, spot) - Math.min(...ks, spot)) / spot) * 2 + 0.01));
  const pc = payoffCurve(L, spot, width, 141), T = yearsTo(ch.expiry);
  const t0 = pc.points.map((p) => L.reduce((a, l) => a + l.qty * (bs({ S: p.S, K: l.strike, T, sigma: smileIV(spot, l.strike), type: l.type }).price - l.avg), 0));
  const W = 640, H = 240, P = 30, xs = pc.points.map((p) => p.S), ys = [...pc.points.map((p) => p.pnl), ...t0];
  const x0 = xs[0], x1 = xs.at(-1), y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys), yr = y1 - y0 || 1;
  const X = (v) => P + ((v - x0) / (x1 - x0)) * (W - 2 * P), Y = (v) => 10 + (1 - (v - y0) / yr) * (H - 36);
  const path = pc.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(p.pnl).toFixed(1)}`).join('');
  const tp = pc.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(t0[i]).toFixed(1)}`).join('');
  const area = `${path}L${X(x1)},${Y(0)}L${X(x0)},${Y(0)}Z`;
  const fm = (v) => (Math.abs(v) === Infinity ? 'Unlimited' : signed(v));
  return `<svg viewBox="0 0 ${W} ${H}" class="payoff"><defs><clipPath id="u"><rect width="${W}" height="${Y(0)}"/></clipPath><clipPath id="d"><rect y="${Y(0)}" width="${W}" height="${H}"/></clipPath></defs>
    <path d="${area}" fill="rgba(18,184,134,.25)" clip-path="url(#u)"/><path d="${area}" fill="rgba(240,62,62,.25)" clip-path="url(#d)"/>
    <line x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)"/><line x1="${X(spot)}" x2="${X(spot)}" y1="6" y2="${H - 24}" stroke="var(--brand)" stroke-dasharray="4 3"/>
    <path d="${tp}" fill="none" stroke="#F59F00" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${path}" fill="none" stroke="var(--text)" stroke-width="2"/>
    ${[0, 0.5, 1].map((f) => `<text x="${X(x0 + f * (x1 - x0))}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${num(x0 + f * (x1 - x0), 0)}</text>`).join('')}</svg>
    <div class="legend-line"><span><i style="background:var(--text)"></i>At expiry</span><span><i style="background:#F59F00"></i>Today</span></div>
    <div class="kv small"><div><small>Max profit</small><b class="up">${fm(pc.maxProfit)}</b></div><div><small>Max loss</small><b class="down">${fm(pc.maxLoss)}</b></div><div><small>Breakevens</small><b>${pc.breakevens.map((b) => num(b, 0)).join(', ') || '—'}</b></div></div>`;
}
function legsHtml() {
  if (!legs.length) return '';
  return `<table class="tbl legs"><tbody>${legs.map((l, i) => `<tr><td><b>${l.strike} ${l.type}</b></td><td><button class="tag ${l.side === 'BUY' ? 'buy' : 'sell'}" data-flip="${i}">${l.side}</button></td><td><input class="xs-input" type="number" min="1" max="50" value="${l.lots}" data-lots="${i}" aria-label="Lots"> lots</td><td class="r">${num(l.premium)}</td><td><button class="btn xs ghost" data-rm="${i}">×</button></td></tr>`).join('')}</tbody></table>
  <div class="row end"><button class="btn ghost sm" id="clr">Clear</button><button class="btn sm" id="exec">Place ${legs.length} order(s)</button></div>`;
}

export default {
  title: 'Option chain',
  async render(r) {
    if (r.query.u) U = r.query.u;
    ch = await get(`/api/optionchain/${U}${expiry ? `?expiry=${expiry}` : ''}`);
    if (ch.expiry !== expiry) { expiry = ch.expiry; legs = []; }
    unsub?.(); unsub = live.sub(ch.rows.flatMap((x) => [x.CE.token, x.PE.token]).concat(ch.future ? [ch.future.token] : []));
    for (const x of ch.rows) for (const s of ['CE', 'PE']) live.quotes.set(x[s].token, { ...(live.quotes.get(x[s].token) || {}), ltp: x[s].ltp, pct: x[s].pct, change: x[s].change });
    const maxOI = Math.max(...ch.rows.flatMap((x) => [x.CE.oi, x.PE.oi]));
    const g = (o) => (greeks ? `<td class="r g">${o.delta}</td><td class="r g">${o.theta}</td>` : '');
    return `<section class="page fno"><div class="page-head"><h1>Option chain</h1><div class="row"><div class="seg">${['NIFTY', 'BANKNIFTY'].map((k) => `<button data-u="${k}" class="${k === U ? 'on' : ''}">${k}</button>`).join('')}</div>
      <select id="ex">${ch.expiries.map((e) => `<option ${e === ch.expiry ? 'selected' : ''}>${e}</option>`).join('')}</select><label class="chip"><input type="checkbox" id="gk" ${greeks ? 'checked' : ''}> Greeks</label></div></div>
      <div class="stats"><div class="card stat"><small>${U} spot</small><b>${num(ch.spot)}</b><em>Future ${ch.future ? `<span data-ltp="${esc(ch.future.token)}">${num(ch.future.ltp)}</span>` : '—'}</em></div><div class="card stat"><small>PCR</small><b>${ch.pcr}</b><em>${ch.pcr > 1.1 ? 'Put-heavy' : ch.pcr < 0.9 ? 'Call-heavy' : 'Balanced'}</em></div><div class="card stat"><small>Max pain</small><b>${ch.maxPain}</b><em>Lot ${ch.lot}</em></div><div class="card stat"><small>Days to expiry</small><b>${ch.daysToExpiry}</b><em>${esc(ch.expiry)}</em></div></div>
      ${App.meta.simulator ? `<p class="note">${esc(ch.note)}</p>` : ''}
      <div class="grid2 wide-left"><div class="card"><div class="tbl-wrap chain-wrap"><table class="tbl chain"><thead><tr>${greeks ? '<th class="r g">Δ</th><th class="r g">Θ</th>' : ''}<th class="r">OI</th><th class="r">LTP</th><th></th><th class="c">Strike</th><th></th><th class="r">LTP</th><th class="r">OI</th>${greeks ? '<th class="r g">Δ</th><th class="r g">Θ</th>' : ''}</tr></thead><tbody>
      ${ch.rows.map((x) => { const ic = x.strike < ch.spot, ip = x.strike > ch.spot; return `<tr class="${x.strike === ch.atm ? 'atm' : ''}">${g(x.CE)}<td class="r oi ${ic ? 'itm' : ''}"><i class="oibar ce" style="width:${(x.CE.oi / maxOI) * 100}%"></i>${compact(x.CE.oi)}</td><td class="r ${ic ? 'itm' : ''}"><span data-ltp="${esc(x.CE.token)}">${num(x.CE.ltp)}</span></td><td class="bs ${ic ? 'itm' : ''}"><button class="b" data-leg="CE" data-k="${x.strike}" data-side="BUY">B</button><button class="s" data-leg="CE" data-k="${x.strike}" data-side="SELL">S</button></td><td class="c strike"><b>${x.strike}</b><small>${x.iv}%</small></td><td class="bs ${ip ? 'itm' : ''}"><button class="b" data-leg="PE" data-k="${x.strike}" data-side="BUY">B</button><button class="s" data-leg="PE" data-k="${x.strike}" data-side="SELL">S</button></td><td class="r ${ip ? 'itm' : ''}"><span data-ltp="${esc(x.PE.token)}">${num(x.PE.ltp)}</span></td><td class="r oi ${ip ? 'itm' : ''}"><i class="oibar pe" style="width:${(x.PE.oi / maxOI) * 100}%"></i>${compact(x.PE.oi)}</td>${g(x.PE)}</tr>`; }).join('')}</tbody></table></div></div>
      <div class="card sticky"><h3>Strategy builder</h3><div class="presets">${['Long straddle', 'Short straddle', 'Bull call spread', 'Bear put spread', 'Iron condor'].map((p) => `<button class="chip" data-preset="${p}">${p}</button>`).join('')}</div><div id="legs">${legsHtml()}</div><div id="po">${payoff()}</div></div></div></section>`;
  },
  mount(root) {
    const row = (k) => ch.rows.find((x) => x.strike === k);
    const addLeg = (type, k, side) => { const r = row(k); if (!r) return; legs.push({ type, strike: k, side, lots: 1, token: r[type].token, premium: live.quotes.get(r[type].token)?.ltp || r[type].ltp }); };
    const redraw = () => { root.querySelector('#legs').innerHTML = legsHtml(); root.querySelector('#po').innerHTML = payoff(); };
    root.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => { U = b.dataset.u; expiry = null; legs = []; App.go(`fno?u=${U}`); }));
    root.querySelector('#ex').onchange = (e) => { expiry = e.target.value; legs = []; rerender(); };
    root.querySelector('#gk').onchange = (e) => { greeks = e.target.checked; rerender(); };
    root.addEventListener('click', async (e) => {
      const d = e.target.dataset;
      if (d.leg) { if (legs.length >= 6) return toast('Maximum 6 legs', 'error'); addLeg(d.leg, +d.k, d.side); redraw(); }
      if (d.preset) {
        legs = []; const s = U === 'NIFTY' ? 50 : 100, a = ch.atm;
        const P = { 'Long straddle': [['CE', a, 'BUY'], ['PE', a, 'BUY']], 'Short straddle': [['CE', a, 'SELL'], ['PE', a, 'SELL']], 'Bull call spread': [['CE', a, 'BUY'], ['CE', a + 2 * s, 'SELL']], 'Bear put spread': [['PE', a, 'BUY'], ['PE', a - 2 * s, 'SELL']], 'Iron condor': [['CE', a + 2 * s, 'SELL'], ['CE', a + 4 * s, 'BUY'], ['PE', a - 2 * s, 'SELL'], ['PE', a - 4 * s, 'BUY']] };
        for (const [t, k, side] of P[d.preset]) addLeg(t, k, side);
        redraw();
      }
      if (d.flip) { const l = legs[+d.flip]; l.side = l.side === 'BUY' ? 'SELL' : 'BUY'; redraw(); }
      if (d.rm) { legs.splice(+d.rm, 1); redraw(); }
      if (e.target.id === 'clr') { legs = []; redraw(); }
      if (e.target.id === 'exec') {
        if (!App.user) return App.go('login');
        if (legs.length === 1) return orderWindow(legs[0].token, legs[0].side, { qty: legs[0].lots * ch.lot, product: 'NRML' });
        const open = App.meta.market === 'OPEN';
        try {
          const res = await post('/api/orders/basket', { orders: legs.map((l) => ({ token: l.token, side: l.side, qty: l.lots * ch.lot, order_type: 'MARKET', product: 'NRML', variety: open ? 'REGULAR' : 'AMO', tag: 'STRATEGY' })) });
          const bad = res.filter((x) => !x.ok);
          toast(bad.length ? `${res.length - bad.length} placed, ${bad.length} rejected: ${bad[0].error}` : `Strategy placed: ${res.length} orders`, bad.length ? 'error' : 'success', 6000);
        } catch (x) { toast(x.message, 'error'); }
      }
    });
    root.addEventListener('change', (e) => { if (e.target.dataset.lots) { legs[+e.target.dataset.lots].lots = Math.max(1, Math.min(50, +e.target.value || 1)); root.querySelector('#po').innerHTML = payoff(); } });
  },
  unmount() { unsub?.(); unsub = null; },
};
