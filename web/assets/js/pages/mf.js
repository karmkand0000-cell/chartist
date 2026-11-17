import { App, rerender } from '../app.js';
import { get, post, del } from '../api.js';
import { esc, num, inr, pct, cls, signed, modal, toast, sparkline, empty, tabs, confirmBox } from '../ui.js';

let tab = 'explore', cat = '';
export default {
  title: 'Mutual funds',
  async render() {
    const schemes = await get('/api/mf/schemes');
    const pf = App.user?.status === 'active' ? await get('/api/mf/portfolio') : null;
    const cats = [...new Set(schemes.map((s) => s.category))].sort();
    let body;
    if (tab === 'explore') {
      const list = schemes.filter((s) => !cat || s.category === cat);
      body = `<div class="row between pad"><select id="cat"><option value="">All categories</option>${cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select><small class="muted">NAV source: ${schemes[0]?.source === 'amfi' ? 'AMFI (via mfapi.in)' : 'demo data'}</small></div>
      <div class="mf-grid">${list.map((s) => `<div class="mf-card"><div><b>${esc(s.name)}</b><small class="block muted">${esc(s.house || '')} · ${esc(s.category)}</small></div>
        ${sparkline(s.history.map((h) => h[1]), 220, 40)}
        <div class="kv small"><div><small>NAV (${esc(s.nav_date)})</small><b>${num(s.nav, 2)}</b></div><div><small>1Y</small><b class="${cls(s.r1)}">${s.r1 == null ? '—' : pct(s.r1)}</b></div><div><small>3Y CAGR</small><b class="${cls(s.r3)}">${s.r3 == null ? '—' : pct(s.r3)}</b></div><div><small>5Y CAGR</small><b class="${cls(s.r5)}">${s.r5 == null ? '—' : pct(s.r5)}</b></div></div>
        <div class="row"><button class="btn sm" data-sip="${esc(s.code)}">Start SIP</button><button class="btn sm ghost" data-lump="${esc(s.code)}">One-time</button></div></div>`).join('')}</div>`;
    } else if (!pf) body = empty('Log in with an active account to see your investments.', '<a class="btn sm" href="#/login">Log in</a>');
    else {
      const inv = pf.holdings.reduce((a, h) => a + h.invested, 0), cur = pf.holdings.reduce((a, h) => a + h.current, 0);
      body = `<div class="stats"><div class="card stat"><small>Invested</small><b>${inr(inv)}</b></div><div class="card stat"><small>Current</small><b>${inr(cur)}</b></div><div class="card stat"><small>Returns</small><b class="${cls(cur - inv)}">${signed(cur - inv)}</b></div><div class="card stat"><small>Active SIPs</small><b>${pf.sips.length}</b></div></div>
        ${pf.holdings.length ? `<table class="tbl"><thead><tr><th>Fund</th><th class="r">Units</th><th class="r">Invested</th><th class="r">Current</th><th class="r">Returns</th><th></th></tr></thead><tbody>${pf.holdings.map((h) => `<tr><td>${esc(h.name)}<small class="block muted">${esc(h.category)}</small></td><td class="r">${num(h.units, 3)}</td><td class="r">${inr(h.invested)}</td><td class="r">${inr(h.current)}</td><td class="r ${cls(h.pnl)}">${signed(h.pnl)}</td><td class="r"><button class="btn xs ghost" data-red="${esc(h.code)}">Redeem</button></td></tr>`).join('')}</tbody></table>` : empty('No mutual fund investments yet.')}
        <h4>SIPs</h4>${pf.sips.length ? `<table class="tbl">${pf.sips.map((s) => `<tr><td>${esc(s.name)}</td><td class="r">${inr(s.amount)}/month on day ${s.day}</td><td class="r muted">next ${esc(s.next_date)} · ${s.installments} done</td><td class="r"><button class="btn xs danger" data-stop="${s.id}">Stop</button></td></tr>`).join('')}</table>` : '<p class="muted">No active SIPs.</p>'}
        <h4>Recent transactions</h4>${pf.orders.length ? `<table class="tbl">${pf.orders.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.side}${o.sip_id ? ' (SIP)' : ''}</td><td class="r">${inr(o.amount)}</td><td class="r">${num(o.units, 3)} @ ${num(o.nav, 2)}</td><td class="muted">${new Date(o.created_at).toLocaleDateString('en-IN')}</td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}`;
    }
    return `<section class="page"><div class="page-head"><h1>Mutual funds</h1></div><div class="card">${tabs('mf', [['explore', 'Explore funds'], ['mine', 'My investments']], tab)}${body}
      <p class="muted small">Mutual fund investments are subject to market risks; read all scheme-related documents carefully. Past returns do not guarantee future performance.</p></div></section>`;
  },
  async mount(root) {
    const schemes = await get('/api/mf/schemes');
    root.querySelector('[data-tabs="mf"]').onclick = (e) => { if (e.target.dataset.tab) { tab = e.target.dataset.tab; rerender(); } };
    const c = root.querySelector('#cat'); if (c) c.onchange = (e) => { cat = e.target.value; rerender(); };
    root.onclick = async (e) => {
      const d = e.target.dataset;
      const s = schemes.find((x) => x.code === (d.sip || d.lump));
      if (s) {
        if (!App.user) return App.go('login');
        if (App.user.status !== 'active') return App.go('onboarding');
        const isSip = !!d.sip;
        const m = modal(`<h3>${isSip ? 'Start SIP' : 'Invest one-time'}</h3><p class="muted">${esc(s.name)} · NAV ${num(s.nav, 2)}</p><form id="f"><label>Amount (₹)<input name="amount" type="number" min="${isSip ? s.min_sip : s.min_lump}" step="100" value="${isSip ? 2000 : 5000}" required></label>
          ${isSip ? `<label>SIP date<select name="day">${[1, 5, 10, 15, 20, 25].map((x) => `<option>${x}</option>`).join('')}</select></label><label class="chip"><input type="checkbox" name="firstToday" checked> Pay first instalment today</label>` : ''}<p class="form-err" id="er"></p><div class="row end"><button class="btn">${isSip ? 'Start SIP' : 'Invest'}</button></div></form>`);
        m.el.querySelector('#f').onsubmit = async (ev) => {
          ev.preventDefault(); const v = Object.fromEntries(new FormData(ev.target));
          try { if (isSip) await post('/api/mf/sip', { code: s.code, amount: v.amount, day: v.day, firstToday: !!v.firstToday }); else await post('/api/mf/invest', { code: s.code, amount: v.amount }); toast(isSip ? 'SIP started' : 'Investment done', 'success'); m.close(); tab = 'mine'; rerender(); }
          catch (x) { m.el.querySelector('#er').textContent = x.message; }
        };
      }
      try {
        if (d.red && (await confirmBox('Redeem all units of this fund at the latest NAV?'))) { await post('/api/mf/redeem', { code: d.red, all: true }); toast('Redeemed', 'success'); rerender(); }
        if (d.stop && (await confirmBox('Stop this SIP?'))) { await del(`/api/mf/sip/${d.stop}`); toast('SIP stopped'); rerender(); }
      } catch (x) { toast(x.message, 'error'); }
    };
  },
};
